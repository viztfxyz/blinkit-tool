/**
 * Blinkit as a registry platform. Blinkit's product ids are numbers; they are strings everywhere
 * outside this file and parsed back here, so no other layer knows the difference.
 */
import { HandcartError } from "../../core/errors.js";
import type {
  Address,
  Bill,
  BillLine,
  Cart,
  CartLine,
  PlatformSession,
  Product,
  ProductDetails,
  SearchOptions,
} from "../../core/types.js";
import { type PayOptions, type PayStatus, payWithUpi, readPayStatus } from "../../pay/index.js";
import type { Platform, PlatformDescriptor } from "../registry.js";
import { Blinkit } from "./client.js";
import { paths } from "./config.js";
import type {
  BlinkitAddress,
  BlinkitBill,
  BlinkitCart,
  BlinkitCartLine,
  BlinkitProduct,
  BlinkitProductDetails,
} from "./types.js";

function productId(id: string): number {
  const n = Number(String(id).trim());
  if (!Number.isInteger(n) || n <= 0) throw new HandcartError(`'${id}' is not a Blinkit product id (a number)`);
  return n;
}

const product = (p: BlinkitProduct): Product => ({
  id: String(p.productId),
  name: p.name,
  brand: p.brand,
  unit: p.unit,
  price: p.price,
  mrp: p.mrp,
  discountPct: p.discountPct,
  inStock: p.inStock,
  image: p.image,
  url: p.url,
  ...(p.related ? { related: true } : {}),
});

const details = (p: BlinkitProductDetails): ProductDetails => ({
  ...product({ ...(p as BlinkitProduct), productId: p.productId }),
  ...(p.breadcrumbs ? { breadcrumbs: p.breadcrumbs } : {}),
  attributes: p.attributes,
});

const line = (i: BlinkitCartLine): CartLine => ({
  id: String(i.productId),
  name: i.name,
  unit: i.unit,
  quantity: i.quantity,
  price: i.price,
  mrp: i.mrp,
  lineTotal: i.lineTotal,
  image: i.image,
});

const address = (a: BlinkitAddress): Address => ({
  id: String(a.id),
  label: a.label,
  name: a.name,
  text: a.text,
  ...(a.serviceable === undefined ? {} : { serviceable: a.serviceable }),
  ...(a.lat == null ? {} : { lat: a.lat }),
  ...(a.lon == null ? {} : { lon: a.lon }),
});

/** Blinkit reports per-line trouble as cart outcomes rather than a list of problems. */
function issues(c: BlinkitCart): string[] {
  const out: string[] = [];
  for (const o of c.outcomes ?? []) {
    if (o.outcome === "applied" || o.outcome === "removed") continue;
    out.push(`${o.productId}: ${o.outcome}${o.granted != null ? ` (got ${o.granted})` : ""}`);
  }
  if (c.unavailableProducts.length) out.push(`${c.unavailableProducts.length} product(s) unavailable here`);
  return out;
}

const cart = (c: BlinkitCart): Cart => ({
  items: c.items.map(line),
  itemsMrp: c.bill.itemsMrp,
  itemsTotal: c.bill.itemsTotal,
  total: c.bill.toPay,
  issues: issues(c),
});

function billLines(b: BlinkitBill): BillLine[] {
  const lines: BillLine[] = [
    {
      type: "ITEM_TOTAL",
      label: "Item total",
      amount: b.itemsTotal,
      ...(b.itemsMrp > b.itemsTotal ? { listAmount: b.itemsMrp } : {}),
    },
    { type: "DELIVERY_FEE", label: "Delivery", amount: b.deliveryCharge },
  ];
  for (const [k, v] of Object.entries(b.chargesBreakdown)) {
    lines.push({ type: k.toUpperCase(), label: k.replace(/_/g, " "), amount: v });
  }
  if (b.promoDiscount) lines.push({ type: "PROMO", label: "Promo", amount: -b.promoDiscount });
  return lines;
}

class BlinkitPlatform implements Platform {
  constructor(readonly bk = new Blinkit()) {}

  async requestOtp(phone: string): Promise<{ sent: true; to: string }> {
    await this.bk.account.requestOtp(phone);
    return { sent: true, to: `******${String(phone).replace(/\D/g, "").slice(-4)}` };
  }

  verifyOtp(code: string) {
    return this.bk.account.verifyOtp(code);
  }

  logout() {
    return this.bk.account.logout();
  }

  async whoami(): Promise<PlatformSession> {
    const w = this.bk.account.whoami();
    const to = w.deliveryAddress;
    return {
      loggedIn: w.loggedIn,
      deliverTo: to ? { label: to.label, text: to.text } : null,
      detail: {
        userId: w.userId,
        phone: w.phone,
        deliveryArea: w.deliveryArea,
        pricing: w.pricing,
        cartId: w.cartId,
        cartItems: w.cartItems,
      },
    };
  }

  async addresses(): Promise<Address[]> {
    const current = this.bk.state.address?.id;
    return (await this.bk.account.addresses()).map((a) => ({ ...address(a), selected: a.id === current }));
  }

  async useAddress(which: string): Promise<Address> {
    const { address: a } = await this.bk.account.useAddress(which);
    return { id: String(a.id), label: a.label, name: null, text: a.text, selected: true, lat: a.lat, lon: a.lon };
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Product[]> {
    return (await this.bk.catalog.search(query, opts)).map(product);
  }

  async product(id: string): Promise<Product> {
    return details(await this.bk.catalog.product(productId(id)));
  }

  async cart(): Promise<Cart> {
    return cart(await this.bk.cart.get());
  }

  async setQuantity(id: string, quantity: number): Promise<Cart> {
    return cart(await this.bk.cart.set({ [productId(id)]: quantity }));
  }

  async add(id: string, quantity = 1): Promise<Cart> {
    return cart(await this.bk.cart.add(productId(id), quantity));
  }

  async clear(): Promise<Cart> {
    return cart(await this.bk.cart.clear());
  }

  async checkout(): Promise<Bill> {
    const c = await this.bk.cart.checkout();
    return {
      total: c.bill.toPay,
      lines: billLines(c.bill),
      items: c.items.map(line),
      address: this.bk.state.address?.text ?? null,
      etaMinutes: null,
      issues: issues(c),
      nextStep: `handcart blinkit pay --confirm ${c.bill.toPay}`,
    };
  }

  pay(opts: PayOptions): Promise<PayStatus> {
    return payWithUpi(this.bk, opts);
  }

  payEnv(): Record<string, string> {
    return { BLINKIT_SESSION: this.bk.sessionFile };
  }

  payStatus(): PayStatus {
    return readPayStatus(paths.payStatus);
  }

  payStatusFile(): string {
    return paths.payStatus;
  }

  categories() {
    return this.bk.catalog.categories();
  }

  findCategory(name: string) {
    return this.bk.catalog.findCategory(name);
  }

  async browse(category: string, opts: SearchOptions = {}) {
    const r = await this.bk.catalog.browse(category, opts);
    return { ...r, products: r.products.map(product) };
  }

  locate(pincode: string) {
    return this.bk.locate(pincode);
  }

  setLocation(where: { pincode?: string; lat?: number; lon?: number }) {
    return this.bk.setLocation(where);
  }
}

export const blinkit: PlatformDescriptor = {
  name: "blinkit",
  label: "Blinkit",
  create: () => new BlinkitPlatform(),
  capabilities: [
    "search",
    "product",
    "cart",
    "checkout",
    "pay",
    "addresses",
    "login",
    "categories",
    "browse",
    "locate",
  ],
};
