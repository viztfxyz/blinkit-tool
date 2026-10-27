import { BlinkitError } from "../core/errors.js";
import type { Json } from "../types.js";
import { NOW_BRAND, NOW_HOME } from "./config.js";
import { NowLogin, type OtpChannel } from "./login.js";
import { parseAddresses, parseBill, parseCart, parseOrder, parseProduct } from "./parsing.js";
import { type NowPayOptions, payNow } from "./pay.js";
import { NowSession } from "./session.js";
import type { NowAddress, NowBill, NowCart, NowOrder, NowPayStatus, NowProduct } from "./types.js";

const ASIN = /^[A-Z0-9]{10}$/;
const GLOW = "storeContext=amazontez&pageType=amazontez&actionSource=tez-glow";

function asin(id: string): string {
  const a = String(id).trim().toUpperCase();
  if (!ASIN.test(a)) throw new BlinkitError(`"${id}" is not an ASIN (10 letters/digits, e.g. B018E0HQPE)`);
  return a;
}

/**
 * Unofficial Amazon Now (amazon.in 10-minute delivery) client. Login and payment run in headless
 * Chromium; search, cart and checkout are plain HTTP on the saved session
 * (`~/.config/blinkit-tool/amazon-now.cookies`, or `$AMAZON_NOW_COOKIES`).
 *
 * Delivery goes to the account's selected Amazon address; pay uses UPI QR only, never Amazon Pay balance.
 */
export class AmazonNow {
  readonly session: NowSession;
  private login: NowLogin;

  constructor(cookieFile?: string) {
    this.session = new NowSession(cookieFile);
    this.login = new NowLogin(this.session);
  }

  get loggedIn(): boolean {
    return this.session.loggedIn;
  }

  // ---------- account ----------

  requestOtp(phone: string, channel: OtpChannel = "sms") {
    return this.login.requestOtp(phone, channel);
  }

  verifyOtp(code: string) {
    return this.login.verifyOtp(code);
  }

  /** Abandon a login started with requestOtp; the saved session is left as it was. */
  cancelLogin(): Promise<void> {
    return this.login.cancel();
  }

  async logout() {
    await this.login.cancel();
    this.session.logout();
    return { loggedOut: true };
  }

  /** Login state, delivery address and store ETA. */
  async whoami() {
    if (!this.loggedIn) return { loggedIn: false };
    const selected = (await this.addresses()).find((a) => a.selected);
    return {
      loggedIn: true,
      deliverTo: selected ? { label: selected.label, text: selected.text, serviceable: selected.serviceable } : null,
    };
  }

  // ---------- addresses ----------

  private async addressBook() {
    this.session.requireLogin();
    const r = await this.session.raw("POST", `/portal-migration/hz/glow/get-address-selections-view-model?${GLOW}`, {
      json: {},
      from: NOW_HOME,
      headers: { "x-requested-with": "XMLHttpRequest" },
    });
    let vm: Json;
    try {
      vm = JSON.parse(r.text);
    } catch {
      throw new BlinkitError(`Amazon didn't return your saved addresses (HTTP ${r.status})`);
    }
    if (!vm?.features?.AddressList) throw new BlinkitError("Amazon didn't return your saved addresses");
    return parseAddresses(vm.features.AddressList);
  }

  /** Saved addresses; `serviceable` says whether Amazon Now delivers there, `selected` which one is in use. */
  async addresses(): Promise<NowAddress[]> {
    return (await this.addressBook()).addresses;
  }

  /** Deliver to a saved address, picked by label, id, or part of the address text. */
  async useAddress(which: string): Promise<NowAddress> {
    const { addresses, csrf } = await this.addressBook();
    const q = which.trim().toLowerCase();
    if (!q) throw new BlinkitError("say which address: a label, an id, or part of the address");
    const exact = addresses.filter((a) => a.id.toLowerCase() === q || a.label?.toLowerCase() === q);
    const loose = addresses.filter((a) => `${a.label ?? ""} ${a.name ?? ""} ${a.text}`.toLowerCase().includes(q));
    const matches = exact.length ? exact : loose;
    if (!matches.length) {
      throw new BlinkitError(`no saved address matches "${which}"; see \`blinkit amazon address\``);
    }
    if (matches.length > 1) {
      throw new BlinkitError(
        `"${which}" matches ${matches.length} addresses (${matches.map((a) => a.label ?? a.id.slice(0, 8)).join(", ")}); be more specific`,
      );
    }
    const target = matches[0];
    if (!target.serviceable) throw new BlinkitError(`Amazon Now doesn't deliver to "${target.label ?? target.text}"`);
    if (target.selected) return target;
    if (!csrf) throw new BlinkitError("Amazon didn't provide the token needed to change the address; try again");
    // The web app's setSelectedLocationInGlow: no tez-brand/group headers, CSRF from the address list.
    await this.session.raw("POST", "/portal-migration/hz/glow/address-change?actionSource=tez-glow", {
      json: {
        addressId: target.id,
        actionSource: "tez-glow",
        pageType: "amazontez",
        storeContext: "amazontez",
        locationType: "ACCOUNT_ADDRESS",
      },
      from: NOW_HOME,
      headers: { "anti-csrftoken-a2z": csrf, "x-requested-with": "XMLHttpRequest" },
    });
    this.session.resetStore();
    // Trust the address list, not the reply: Amazon has answered address changes with an empty 200.
    const now = (await this.addresses()).find((a) => a.selected);
    if (now?.id !== target.id) {
      throw new BlinkitError(`Amazon didn't switch to "${target.label ?? target.text}"; try again`);
    }
    return now;
  }

  // ---------- catalog ----------

  async search(query: string, opts: { limit?: number; inStock?: boolean } = {}): Promise<NowProduct[]> {
    const q = encodeURIComponent(query.trim());
    if (!q) throw new BlinkitError("search needs a query");
    const data = await this.session.api(
      "GET",
      `/tez/browse/searchByKeyword?keyword=${q}&brandId=${NOW_BRAND}&offset=0&spellCorrectionDisabled=false`,
      { from: `${NOW_HOME.replace("/home", "/search")}` },
    );
    let items = (data?.data?.searchResponse?.products ?? []).map(parseProduct);
    if (opts.inStock) items = items.filter((p: NowProduct) => p.inStock);
    return items.slice(0, opts.limit ?? 24);
  }

  async products(asins: string[]): Promise<NowProduct[]> {
    const data = await this.session.api("POST", `/tez/browse/recs/productDetails?brandId=${NOW_BRAND}`, {
      json: { asins: asins.map(asin), brandId: NOW_BRAND },
    });
    return (data?.data?.productDetails ?? []).map(parseProduct);
  }

  async product(id: string): Promise<NowProduct> {
    const [p] = await this.products([id]);
    if (!p) throw new BlinkitError(`Amazon Now doesn't sell ${asin(id)} at your address`);
    return p;
  }

  // ---------- cart ----------

  private async rawCart(): Promise<Json> {
    this.session.requireLogin();
    const data = await this.session.api("POST", `/tez/order/getcart?brandId=${NOW_BRAND}`, {
      json: {
        brandId: NOW_BRAND,
        initiatePurchase: false,
        withProductDetails: true,
        triggerCartHealing: true,
        withWalletDetails: false,
      },
    });
    return data?.data?.cartResponse ?? {};
  }

  async cart(): Promise<NowCart> {
    return parseCart(await this.rawCart());
  }

  /** Set an absolute quantity (0 removes). */
  async setQuantity(id: string, quantity: number): Promise<NowCart> {
    const a = asin(id);
    if (!Number.isInteger(quantity) || quantity < 0) throw new BlinkitError("quantity must be a whole number ≥ 0");
    const current = (await this.rawCart()).cartItems?.find((i: Json) => i.asin === a);
    const offer = current ?? (quantity > 0 ? await this.product(a) : undefined);
    if (!offer) return this.cart(); // removing something that isn't there
    if (quantity > 0 && !offer.offerId) throw new BlinkitError(`${a} has no offer at your address right now`);
    await this.session.api("POST", `/tez/order/atc?brandId=${NOW_BRAND}`, {
      json: {
        setQuantityFlag: true,
        asin: a,
        offerId: offer.offerId,
        brandId: NOW_BRAND,
        storeId: offer.storeId,
        quantity,
        initiatePurchase: false,
        ...(current?.itemId ? { itemId: current.itemId } : {}),
      },
    });
    return this.cart();
  }

  async add(id: string, quantity = 1): Promise<NowCart> {
    const a = asin(id);
    const have = (await this.cart()).items.find((i) => i.asin === a)?.quantity ?? 0;
    return this.setQuantity(a, have + quantity);
  }

  async clear(): Promise<NowCart> {
    this.session.requireLogin();
    await this.session.api("POST", `/tez/order/clearcart?almBrandId=${NOW_BRAND}`, { json: {} });
    return this.cart();
  }

  // ---------- checkout & pay ----------

  /** The payable bill for the cart and the account's selected address. Doesn't place the order. */
  async checkout(): Promise<NowBill> {
    this.session.requireLogin();
    try {
      const data = await this.session.api("POST", `/tez/order/createPurchase?brandId=${NOW_BRAND}`, { json: {} });
      return parseBill(data?.data?.purchaseResponse);
    } catch (e) {
      // Seen live: while an order placed by `pay` is still unpaid (or being cancelled after its QR
      // expired), createPurchase answers 400 and the cart is empty because the items moved to that order.
      if (e instanceof BlinkitError && e.status === 200 && /Bad Request/i.test(e.message)) {
        const open = (await this.orders().catch(() => [])).map((o) => `${o.orderId}: ${o.status}`).join("; ");
        throw new BlinkitError(
          `Amazon has an earlier order that isn't settled yet${open ? ` (${open})` : ""}; ` +
            "an unpaid order is cancelled automatically, so try again in a few minutes",
        );
      }
      throw e;
    }
  }

  /** Orders Amazon Now still shows as active (placed, unpaid, out for delivery or just cancelled). */
  async orders(): Promise<NowOrder[]> {
    this.session.requireLogin();
    const data = await this.session.api("GET", `/tez/order/getActiveOrderDetails?brandId=${NOW_BRAND}`, {
      from: NOW_HOME,
    });
    return (data?.data?.activeOrderDetailsResponse?.orders ?? []).map(parseOrder);
  }

  /** Place the order and hand over a UPI QR. Never uses Amazon Pay balance. */
  pay(opts: NowPayOptions): Promise<NowPayStatus> {
    return payNow({ session: this.session, checkout: () => this.checkout(), cart: () => this.cart() }, opts);
  }
}
