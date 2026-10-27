/** Zepto as a registry platform. Zepto's ids are already strings (product variant UUIDs). */
import type {
  Address,
  Bill,
  Cart,
  CartLine,
  Order,
  PlatformSession,
  Product,
  SearchOptions,
} from "../../core/types.js";
import type { PayOptions, PayStatus } from "../../pay/index.js";
import type { Platform, PlatformDescriptor } from "../registry.js";
import { Zepto } from "./client.js";
import { zeptoPaths } from "./config.js";
import { readZeptoPayStatus } from "./pay.js";
import type { ZeptoAddress, ZeptoBill, ZeptoCart, ZeptoCartLine, ZeptoProduct } from "./types.js";

const product = (p: ZeptoProduct): Product => ({
  id: p.id,
  name: p.name,
  brand: p.brand,
  unit: p.unit,
  price: p.price,
  mrp: p.mrp,
  discountPct: p.discountPct,
  inStock: p.inStock,
  image: p.image,
  url: p.url,
});

const line = (i: ZeptoCartLine): CartLine => ({
  id: i.id,
  name: i.name,
  unit: i.unit,
  quantity: i.quantity,
  price: i.price,
  mrp: i.mrp,
  lineTotal: i.lineTotal,
  image: i.image,
});

const address = (a: ZeptoAddress): Address => ({
  id: a.id,
  label: a.label,
  name: a.name,
  text: a.text,
  selected: a.selected,
  lat: a.latitude,
  lon: a.longitude,
});

const cart = (c: ZeptoCart): Cart => ({
  items: c.items.map(line),
  itemsMrp: c.itemsMrp,
  itemsTotal: c.itemsTotal,
  total: c.total,
  issues: c.issues,
});

const bill = (b: ZeptoBill): Bill => ({
  total: b.total,
  lines: b.lines,
  items: b.items.map(line),
  address: b.address,
  etaMinutes: b.etaMinutes,
  issues: b.issues,
  nextStep: `handcart zepto pay --confirm ${b.total}`,
});

/**
 * Zepto's search takes a query and a page size and nothing else, so the shared price/brand/sort
 * options are applied here, to what came back. Display only: the request is unchanged.
 */
function refine(items: Product[], opts: SearchOptions): Product[] {
  const out = items.filter(
    (p) =>
      !(
        (opts.maxPrice !== undefined && p.price > opts.maxPrice) ||
        (opts.minPrice !== undefined && p.price < opts.minPrice) ||
        (opts.brand && !(p.brand ?? "").toLowerCase().includes(opts.brand.toLowerCase())) ||
        p.discountPct < (opts.minDiscount ?? 0)
      ),
  );
  const key: Record<string, (p: Product) => number> = {
    price: (p) => p.price,
    price_desc: (p) => -p.price,
    discount: (p) => -p.discountPct,
  };
  const k = key[opts.sort ?? "relevance"];
  if (k) out.sort((a, b) => k(a) - k(b));
  return out;
}

class ZeptoPlatform implements Platform {
  constructor(readonly zp = new Zepto()) {}

  requestOtp(phone: string) {
    return this.zp.requestOtp(phone);
  }

  verifyOtp(code: string) {
    return this.zp.verifyOtp(code);
  }

  logout() {
    return this.zp.logout();
  }

  async whoami(): Promise<PlatformSession> {
    const w = await this.zp.whoami();
    return { loggedIn: w.loggedIn, deliverTo: ("deliverTo" in w ? w.deliverTo : null) ?? null };
  }

  async addresses(): Promise<Address[]> {
    return (await this.zp.addresses()).map(address);
  }

  async useAddress(which: string): Promise<Address> {
    return address(await this.zp.useAddress(which));
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Product[]> {
    const found = await this.zp.search(query, { limit: opts.limit, inStock: opts.inStock });
    return refine(found.map(product), opts);
  }

  async product(id: string): Promise<Product> {
    return product(await this.zp.product(id));
  }

  async cart(): Promise<Cart> {
    return cart(await this.zp.cart());
  }

  async setQuantity(id: string, quantity: number): Promise<Cart> {
    return cart(await this.zp.setQuantity(id, quantity));
  }

  async add(id: string, quantity = 1): Promise<Cart> {
    return cart(await this.zp.add(id, quantity));
  }

  async clear(): Promise<Cart> {
    return cart(await this.zp.clear());
  }

  async checkout(): Promise<Bill> {
    return bill(await this.zp.checkout());
  }

  orders(): Promise<Order[]> {
    return this.zp.orders();
  }

  pay(opts: PayOptions): Promise<PayStatus> {
    return this.zp.pay(opts);
  }

  payEnv(): Record<string, string> {
    return { ZEPTO_COOKIES: this.zp.session.cookieFile };
  }

  payStatus(): PayStatus {
    return readZeptoPayStatus();
  }

  payStatusFile(): string {
    return zeptoPaths.payStatus;
  }
}

export const zepto: PlatformDescriptor = {
  name: "zepto",
  label: "Zepto",
  create: () => new ZeptoPlatform(),
  capabilities: ["search", "product", "cart", "checkout", "pay", "orders", "addresses", "login"],
};
