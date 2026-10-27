import { HandcartError } from "../../core/errors.js";
import { SORTS, type Sort } from "../../core/types.js";
import { BASE, CHARGE_NAMES } from "./config.js";
import type { BlinkitAddress, BlinkitCart, BlinkitProduct, Filters, Json, Pricing } from "./types.js";

/** Depth-first search for the first object-valued `key`. */
export function findKey(o: Json, key: string): Json | undefined {
  if (Array.isArray(o)) {
    for (const v of o) {
      const r = findKey(v, key);
      if (r) return r;
    }
  } else if (o && typeof o === "object") {
    if (o[key] && typeof o[key] === "object" && !Array.isArray(o[key])) return o[key];
    for (const v of Object.values(o)) {
      const r = findKey(v, key);
      if (r) return r;
    }
  }
  return undefined;
}

/** Yield the `data` of every snippet with the given widget_type, anywhere in the tree. */
export function* walkWidgets(o: Json, widgetType: string): Generator<Json> {
  if (Array.isArray(o)) {
    for (const v of o) yield* walkWidgets(v, widgetType);
  } else if (o && typeof o === "object") {
    if (o.widget_type === widgetType && o.data && typeof o.data === "object") yield o.data;
    for (const v of Object.values(o)) yield* walkWidgets(v, widgetType);
  }
}

export const maskPhone = (phone?: string | null) => (phone ? `******${String(phone).slice(-4)}` : null);

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalise a Blinkit `cart_item` (embedded in product cards) into a BlinkitProduct. */
export function fromCartItem(ci: Json, card: Json = {}): BlinkitProduct {
  const price = ci.price ?? 0;
  const mrp = ci.mrp ?? price;
  const productId = Number(ci.product_id);
  const name = ci.display_name || ci.product_name || ci.name || "";
  return {
    productId,
    name,
    brand: ci.brand ?? null,
    unit: ci.unit ?? null,
    price,
    mrp,
    discountPct: price && mrp > price ? Math.round((100 * (mrp - price)) / mrp) : 0,
    // listings flag sold-out cards with product_state while is_sold_out stays false
    inStock: !card.is_sold_out && card.product_state !== "out_of_stock" && (ci.inventory ?? 0) > 0,
    inventory: ci.inventory ?? null,
    merchantId: ci.merchant_id ?? null,
    image: ci.image_url ?? null,
    url: `${BASE}/prn/${slugify(name)}/prid/${productId}`,
  };
}

/** Parse a product card snippet's data; null for non-product snippets. */
export function parseCard(d: Json): BlinkitProduct | null {
  const ci = d?.atc_action?.add_to_cart?.cart_item ?? findKey(d, "cart_item");
  if (!ci || ci.product_id == null) return null;
  const p = fromCartItem(ci, d);
  if (d.offer && typeof d.offer === "object") p.offer = d.offer.title?.text ?? null;
  return p;
}

export function parseCart(data: Json, pricing: Pricing): BlinkitCart {
  const cd = data?.cart_data ?? {};
  const b = cd.bill_details ?? {};
  const chargesBreakdown: Record<string, number> = {};
  for (const c of cd.additional_charges ?? []) {
    chargesBreakdown[c.name || CHARGE_NAMES[c.charge_id] || `charge_${c.charge_id}`] = c.amount;
  }
  return {
    cartId: cd.id || null,
    pricing,
    items: (cd.items ?? []).map((i: Json) => ({
      productId: i.product_id,
      name: i.name,
      brand: i.brand ?? null,
      unit: i.unit ?? null,
      quantity: i.quantity,
      price: i.price,
      mrp: i.mrp,
      lineTotal: i.total_price,
      maxQuantity: i.inventory_limit ?? null,
      unavailableQuantity: i.unavailable_quantity ?? 0,
      image: i.image_url ?? i.image ?? i.product_image_url ?? null,
    })),
    unavailableProducts: cd.unavailable_products ?? [],
    bill: {
      itemsMrp: b.total_mrp ?? 0,
      itemsTotal: b.total_cost ?? 0,
      productDiscount: b.product_discount ?? 0,
      deliveryCharge: b.delivery_charge ?? 0,
      otherCharges: b.additional_charge ?? 0,
      chargesBreakdown,
      promoDiscount: b.promo_discount ?? 0,
      toPay: b.payable_amount ?? b.bill_total ?? 0,
      freeDeliveryAbove: b.free_delivery_mov ?? null,
    },
    delivery: (data?.page_meta?.custom_data?.shipments ?? []).map((s: Json) => ({
      type: s.shipment_type,
      slot: s.slot_time,
      date: s.slot_date,
    })),
  };
}

export function parseAddress(a: Json): BlinkitAddress {
  const text = a.display_address || [a.line1, a.line2, a.landmark, a.city].filter(Boolean).map(String).join(", ");
  return {
    id: a.id,
    label: a.label ?? null,
    name: a.name ?? null,
    text,
    lat: a.latitude ?? a.coordinate?.lat,
    lon: a.longitude ?? a.coordinate?.lon,
    serviceable: a.is_serviceable ?? a.serviceable,
  };
}

/** How many results to fetch before filtering/sorting, so the top N aren't just page one. */
export function scanSize(limit: number, sort: Sort, filters: Filters): number {
  if (!SORTS.includes(sort)) throw new HandcartError(`sort must be one of ${SORTS.join(", ")}`);
  const filtering = Object.values(filters).some((v) => v !== undefined && v !== false && v !== 0 && v !== "");
  return sort === "relevance" && !filtering ? limit : Math.max(limit * 3, 60);
}

/** Apply filters and sort. Sorting keeps direct matches ahead of `related` padding. */
export function refine(
  items: BlinkitProduct[],
  limit: number,
  sort: Sort = "relevance",
  f: Filters = {},
): BlinkitProduct[] {
  const out = items.filter(
    (p) =>
      !(
        (f.inStock && !p.inStock) ||
        (f.maxPrice !== undefined && p.price > f.maxPrice) ||
        (f.minPrice !== undefined && p.price < f.minPrice) ||
        (f.brand && !(p.brand ?? "").toLowerCase().includes(f.brand.toLowerCase())) ||
        p.discountPct < (f.minDiscount ?? 0)
      ),
  );
  const key: Record<string, (p: BlinkitProduct) => number> = {
    price: (p) => p.price,
    price_desc: (p) => -p.price,
    discount: (p) => -p.discountPct,
  };
  const k = key[sort];
  if (k) out.sort((a, b) => Number(!!a.related) - Number(!!b.related) || k(a) - k(b));
  return out.slice(0, limit);
}
