import { HandcartError } from "../../core/errors.js";
import { indianMobile } from "../../core/phone.js";
import { readJson, writeJson } from "../../core/storage.js";
import type { Json } from "../../core/types.js";
import { ZEPTO_BASE, zeptoPaths } from "./config.js";
import { parseAddresses, parseBill, parseOrder, parseProduct, parseSearch } from "./parsing.js";
import { payZepto, type ZeptoPayOptions } from "./pay.js";
import { ZeptoSession } from "./session.js";
import type { ZeptoAddress, ZeptoBill, ZeptoCart, ZeptoOrder, ZeptoPayStatus, ZeptoProduct } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts a product variant id or a zepto.com product URL (…/pvid/<id>). */
function variantId(id: string): string {
  const s = String(id).trim();
  const v = s.match(/pvid\/([0-9a-f-]{36})/i)?.[1] ?? s;
  if (!UUID.test(v))
    throw new HandcartError(`"${id}" is not a Zepto product id (a UUID, or a zepto.com/pn/…/pvid/<id> link)`);
  return v.toLowerCase();
}

interface CartEntry {
  quantity: number;
  /** The listing at `storeId`; re-resolved when the address is served by another store. */
  storeProductId: string;
  storeId: string;
  /** Paise, as cart/create wants it. */
  mrp: number;
}

/** What Zepto keeps on the device rather than the account: the selected address and the cart. */
interface ZeptoState {
  addressId?: string;
  /** Phone number between requestOtp and verifyOtp (verify needs it again). */
  pendingPhone?: string;
  cart: Record<string, CartEntry>;
}

/** The cart/create reply and the request that produced it; pay needs both. */
export interface PricedCart {
  bill: ZeptoBill;
  raw: Json;
  request: Json;
  address: ZeptoAddress;
}

/**
 * Unofficial Zepto client. Everything is plain HTTP on the saved session
 * (`~/.config/handcart/zepto.cookies`, or `$ZEPTO_COOKIES`); headless Chromium only renews the bot-check
 * cookie every few days. Like the web app, the cart and selected address are kept locally
 * (`~/.config/handcart/zepto.json`) and priced by Zepto on every change.
 *
 * Pay uses a UPI QR only: it never applies Zepto Cash or any wallet.
 */
export class Zepto {
  readonly session: ZeptoSession;

  constructor(
    cookieFile?: string,
    private readonly stateFile = zeptoPaths.state,
  ) {
    this.session = new ZeptoSession(cookieFile);
  }

  get loggedIn(): boolean {
    return this.session.loggedIn;
  }

  private state(): ZeptoState {
    const s = readJson<ZeptoState>(this.stateFile);
    return { ...s, cart: s?.cart ?? {} };
  }

  private save(s: ZeptoState): void {
    writeJson(this.stateFile, s, true);
  }

  // ---------- account ----------

  /** Send a login OTP by SMS to an Indian mobile number. */
  async requestOtp(phone: string): Promise<{ sent: true; to: string }> {
    const mobileNumber = indianMobile(phone);
    if (!mobileNumber) throw new HandcartError("give a 10-digit Indian mobile number");
    await this.session.api("POST", "api/v1/user/customer/send-otp-sms/", {
      json: { mobileNumber, countryCode: "+91" },
    });
    this.save({ ...this.state(), pendingPhone: mobileNumber });
    return { sent: true, to: `******${mobileNumber.slice(-4)}` };
  }

  async verifyOtp(code: string) {
    const st = this.state();
    if (!st.pendingPhone) throw new HandcartError("request an OTP first (`handcart zepto login <phone>`)");
    const otp = code.replace(/\s/g, "");
    if (!/^\d{4,8}$/.test(otp)) throw new HandcartError("OTP rejected: that isn't an OTP (4–8 digits)");
    let r: Json;
    try {
      // A Next.js route on www.zepto.com: it sets the httpOnly accessToken / refreshToken cookies.
      r = await this.session.api("POST", `${ZEPTO_BASE}/api/auth/verify-otp`, {
        json: { mobileNumber: st.pendingPhone, countryCode: "+91", otpToken: otp },
      });
    } catch (e) {
      if (e instanceof HandcartError && (e.status === 400 || e.status === 401 || e.status === 403)) {
        throw new HandcartError(`OTP rejected: ${e.message.replace(/^Zepto \S+ failed: /, "")}`);
      }
      throw e;
    }
    if (!this.loggedIn) throw new HandcartError("Zepto accepted the OTP but didn't start a session; try again");
    const { pendingPhone: _, ...rest } = this.state();
    this.save(rest);
    return { loggedIn: true, phone: r?.user?.mobileNumber ?? st.pendingPhone, name: r?.user?.fullName ?? null };
  }

  logout() {
    this.session.logout();
    return { loggedOut: true };
  }

  /** Login state and delivery address. */
  async whoami() {
    if (!this.loggedIn) return { loggedIn: false };
    const selected = (await this.addresses()).find((a) => a.selected);
    return { loggedIn: true, deliverTo: selected ? { label: selected.label, text: selected.text } : null };
  }

  // ---------- addresses ----------

  /** Saved addresses; `selected` is the one this tool delivers to (the first one until you pick). */
  async addresses(): Promise<ZeptoAddress[]> {
    this.session.requireLogin();
    const r = await this.session.api("POST", "api/v1/gateway/graphql/", {
      // Byte-for-byte the web app's query: the gateway answers other spellings with no data.
      json: {
        operationName: "allRootApisData",
        variables: {},
        query: "query allRootApisData{\n  user{\n   address\n      }\n    }",
      },
    });
    return parseAddresses(r?.data?.user?.address?.userAddresses ?? [], this.state().addressId);
  }

  /** Deliver to a saved address, picked by label, id, or part of the address text. */
  async useAddress(which: string): Promise<ZeptoAddress> {
    const q = which.trim().toLowerCase();
    if (!q) throw new HandcartError("say which address: a label, an id, or part of the address");
    const all = await this.addresses();
    const exact = all.filter((a) => a.id.toLowerCase() === q || a.label?.toLowerCase() === q);
    const loose = all.filter((a) => `${a.label ?? ""} ${a.name ?? ""} ${a.text}`.toLowerCase().includes(q));
    const matches = exact.length ? exact : loose;
    if (!matches.length) throw new HandcartError(`no saved address matches "${which}"; see \`handcart zepto address\``);
    if (matches.length > 1) {
      throw new HandcartError(
        `"${which}" matches ${matches.length} addresses (${matches.map((a) => a.label ?? a.id.slice(0, 8)).join(", ")}); be more specific`,
      );
    }
    const target = matches[0];
    await this.storeFor(target); // fails here, not at checkout, when Zepto doesn't serve it
    this.save({ ...this.state(), addressId: target.id });
    return { ...target, selected: true };
  }

  private async selectedAddress(): Promise<ZeptoAddress> {
    const a = (await this.addresses()).find((x) => x.selected);
    if (!a) throw new HandcartError("no saved address on this Zepto account; add one in the Zepto app or on zepto.com");
    return a;
  }

  /** Which store serves the address (search, prices and stock are per store). */
  private async storeFor(a: ZeptoAddress): Promise<string> {
    const r = await this.session.api(
      "GET",
      `lms/api/v2/get_page?latitude=${a.latitude}&longitude=${a.longitude}&page_type=HOME&version=v2&show_new_eta_banner=true&page_size=3&enforce_platform_type=DESKTOP`,
    );
    const s = r?.storeServiceableResponse;
    if (!s?.serviceable || !s.storeId) {
      throw new HandcartError(`Zepto doesn't deliver to "${a.label ?? a.text}" right now`);
    }
    const storeIds = [s.storeId, ...(s.secondaryStoreIds ?? [])];
    this.session.store = {
      storeId: s.storeId,
      storeIds,
      etas: Object.fromEntries(storeIds.map((id: string) => [id, -1])),
    };
    return s.storeId;
  }

  /** The selected address and its store, set on the session for the calls that follow. */
  private async where(): Promise<{ address: ZeptoAddress; storeId: string }> {
    this.session.requireLogin();
    const address = await this.selectedAddress();
    return { address, storeId: await this.storeFor(address) };
  }

  // ---------- catalog ----------

  async search(query: string, opts: { limit?: number; inStock?: boolean } = {}): Promise<ZeptoProduct[]> {
    const q = query.trim();
    if (!q) throw new HandcartError("search needs a query");
    await this.where();
    const limit = opts.limit ?? 24;
    const out: ZeptoProduct[] = [];
    for (let pageNumber = 0; pageNumber < 4 && out.length < limit; pageNumber++) {
      const page = await this.session.api("POST", "user-search-service/api/v3/search", {
        json: { query: q, pageNumber, mode: "SHOW_ALL_RESULTS", userSessionId: this.session.sessionId },
      });
      for (const p of parseSearch(page)) if (!out.some((o) => o.id === p.id)) out.push(p);
      if (page?.hasReachedEnd !== false) break;
    }
    return (opts.inStock ? out.filter((p) => p.inStock) : out).slice(0, limit);
  }

  private async productAt(id: string, storeId: string): Promise<ZeptoProduct> {
    const v = variantId(id);
    let r: Json;
    try {
      r = await this.session.api(
        "GET",
        `product-assortment-service/api/v2/product-detail?productVariantId=${v}&storeId=${storeId}`,
      );
    } catch (e) {
      if (e instanceof HandcartError && (e.status === 400 || e.status === 404)) {
        throw new HandcartError(`Zepto doesn't sell ${v} at your address`);
      }
      throw e;
    }
    const sp =
      (r?.product?.storeProducts ?? []).find((x: Json) => x?.productVariant?.id === v) ??
      r?.product?.storeProducts?.[0];
    if (!sp) throw new HandcartError(`Zepto doesn't sell ${v} at your address`);
    return { ...parseProduct(sp, r.product, sp.productVariant), storeId: r?.storeId ?? storeId };
  }

  /** One product by variant id (or zepto.com product link), priced at your address. */
  async product(id: string): Promise<ZeptoProduct> {
    const { storeId } = await this.where();
    return this.productAt(id, storeId);
  }

  // ---------- cart ----------

  /** Price the local cart for the selected address (Zepto's cart/create). Doesn't place an order. */
  async price(): Promise<PricedCart> {
    const { address, storeId } = await this.where();
    const st = this.state();
    // Listings are per store: re-resolve anything added while another store served the address.
    for (const [id, e] of Object.entries(st.cart)) {
      if (e.storeId === storeId) continue;
      const p = await this.productAt(id, storeId);
      st.cart[id] = { ...e, storeProductId: p.storeProductId, storeId, mrp: Math.round(p.mrp * 100) };
    }
    this.save(st);
    const products = Object.entries(st.cart).map(([id, e]) => ({
      storeProductId: e.storeProductId,
      productVariantId: id,
      mrp: e.mrp,
      quantity: e.quantity,
      isDiscountApplicable: false,
      isAddedToGiftBag: false,
    }));
    const request = {
      storeId,
      cartId: "",
      cartProducts: products,
      cartProductsV2: products.map((p) => ({ ...p, cartProductId: p.productVariantId, addOns: [] })),
      swappedPvIds: {},
      removedCampaignProducts: [],
      availedCampaignProducts: [],
      availedCampaignProductIds: [],
      deliveryInstructions: {
        leaveAtGate: false,
        doNotRingBell: false,
        bewareOfPets: false,
        returnPaperBag: false,
        returnCokePetBottle: false,
      },
      oosProductMeta: [],
      riderTip: 0,
      latitude: address.latitude,
      longitude: address.longitude,
      // The web app sends true, which spends Zepto Cash first. Never.
      useZeptoCash: false,
      userPreferences: {},
      isLayoutRequired: false,
      locationToAddressDistance: 1,
      sessionMeta: { clearUnserviceableProductsWidget: false },
      userAddressId: address.id,
      couponInfo: [],
      isPtpLayoutMigrationEnabled: true,
      seenElementsInSession: { ptpBottomSheet: false },
    };
    const raw = await this.session.api("POST", "cfs/api/v1/cart/create", { json: request });
    return { bill: parseBill(raw), raw, request, address };
  }

  async cart(): Promise<ZeptoCart> {
    if (!Object.keys(this.state().cart).length) {
      return { items: [], total: 0, issues: [], itemsMrp: 0, itemsTotal: 0 };
    }
    const { bill } = await this.price();
    const sum = (f: (i: ZeptoBill["items"][number]) => number) =>
      Math.round(bill.items.reduce((s, i) => s + f(i), 0) * 100) / 100;
    return {
      items: bill.items,
      total: bill.total,
      issues: bill.issues,
      itemsMrp: sum((i) => i.mrp * i.quantity),
      itemsTotal: sum((i) => i.lineTotal),
    };
  }

  /** Set an absolute quantity (0 removes). */
  async setQuantity(id: string, quantity: number): Promise<ZeptoCart> {
    const v = variantId(id);
    if (!Number.isInteger(quantity) || quantity < 0) throw new HandcartError("quantity must be a whole number ≥ 0");
    const st = this.state();
    if (quantity === 0) {
      delete st.cart[v];
    } else {
      const p = await this.product(v);
      if (!p.inStock) throw new HandcartError(`${p.name} is out of stock at your address`);
      if (p.maxQuantity && quantity > p.maxQuantity) {
        throw new HandcartError(`Zepto allows at most ${p.maxQuantity} of ${p.name}`);
      }
      st.cart[v] = {
        quantity,
        storeProductId: p.storeProductId,
        storeId: this.session.store?.storeId ?? p.storeId ?? "",
        mrp: Math.round(p.mrp * 100),
      };
    }
    this.save(st);
    return this.cart();
  }

  async add(id: string, quantity = 1): Promise<ZeptoCart> {
    const v = variantId(id);
    return this.setQuantity(v, (this.state().cart[v]?.quantity ?? 0) + quantity);
  }

  async clear(): Promise<ZeptoCart> {
    this.save({ ...this.state(), cart: {} });
    return this.cart();
  }

  // ---------- checkout & pay ----------

  /** The payable bill for the cart and the selected address. Doesn't place the order. */
  async checkout(): Promise<ZeptoBill> {
    return (await this.price()).bill;
  }

  /** Recent Zepto orders, newest first. */
  async orders(): Promise<ZeptoOrder[]> {
    this.session.requireLogin();
    const r = await this.session.api("GET", "api/v2/order/?pageNumber=1");
    return (r?.orders ?? []).map(parseOrder);
  }

  /** Place the order and hand over a UPI QR. Never uses Zepto Cash or a wallet. */
  pay(opts: ZeptoPayOptions): Promise<ZeptoPayStatus> {
    return payZepto(
      {
        session: this.session,
        price: () => this.price(),
        clearCart: () => this.save({ ...this.state(), cart: {} }),
      },
      opts,
    );
  }
}
