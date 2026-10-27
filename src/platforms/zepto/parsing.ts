import type { Json } from "../../core/types.js";
import { ZEPTO_BASE, ZEPTO_CDN } from "./config.js";
import type { ZeptoAddress, ZeptoBill, ZeptoBillLine, ZeptoCartLine, ZeptoOrder, ZeptoProduct } from "./types.js";

/** Zepto amounts are integer paise. */
export const rupees = (paise: unknown): number => {
  const n = Number(paise);
  return Number.isFinite(n) ? Math.round(n) / 100 : 0;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const image = (pv: Json): string | null => {
  const path = pv?.images?.[0]?.path;
  return typeof path === "string" && path ? ZEPTO_CDN + path : null;
};

/**
 * A store product as search and product-detail return it: `sp` carries the price and stock, with the
 * variant (`productVariant`) and product (`product`) either nested in it or passed alongside.
 */
export function parseProduct(sp: Json, product: Json = sp?.product, variant: Json = sp?.productVariant): ZeptoProduct {
  const name = String(product?.name ?? "");
  const id = String(variant?.id ?? sp?.productVariantId ?? "");
  const price = rupees(sp?.discountedSellingPrice ?? sp?.sellingPrice);
  const mrp = rupees(sp?.mrp) || price;
  return {
    id,
    storeProductId: String(sp?.id ?? ""),
    storeId: sp?.storeId ?? null,
    name,
    brand: product?.brand ?? null,
    unit: variant?.formattedPacksize ?? null,
    price,
    mrp,
    discountPct: mrp > price ? Math.round((1 - price / mrp) * 100) : 0,
    inStock: sp?.outOfStock !== true && (sp?.availableQuantity == null || Number(sp.availableQuantity) > 0),
    maxQuantity: variant?.maxAllowedQuantity ?? null,
    image: image(variant),
    url: `${ZEPTO_BASE}/pn/${slug(name) || "product"}/pvid/${id}`,
  };
}

/** Products from a /user-search-service/api/v3/search page (PRODUCT_GRID widgets). */
export function parseSearch(page: Json): ZeptoProduct[] {
  const out: ZeptoProduct[] = [];
  for (const w of page?.layout ?? []) {
    if (w?.widgetId !== "PRODUCT_GRID") continue;
    for (const item of w?.data?.resolver?.data?.items ?? []) {
      const pr = item?.productResponse;
      if (pr?.productVariant?.id) out.push(parseProduct(pr, pr.product, pr.productVariant));
    }
  }
  return out;
}

export function parseAddresses(list: Json[], selectedId: string | undefined): ZeptoAddress[] {
  const chosen = list.some((a) => a?.id === selectedId) ? selectedId : list[0]?.id;
  return list.map((a) => ({
    id: String(a.id),
    label: a.name || (a.type ? String(a.type).toLowerCase() : null),
    name: a.contactName ?? null,
    text: a.displayText ?? [a.flatDetails, a.googleFormattedAddress].filter(Boolean).join(", "),
    latitude: Number(a.latitude),
    longitude: Number(a.longitude),
    selected: a.id === chosen,
  }));
}

function cartLines(c: Json): ZeptoCartLine[] {
  const seen = new Map<string, ZeptoCartLine>();
  for (const store of c?.storeLevelCartProducts ?? []) {
    for (const cp of store?.cartProducts ?? []) {
      const sp = cp?.storeProduct;
      const id = String(sp?.productVariantId ?? sp?.productVariant?.id ?? "");
      if (!id || seen.has(id)) continue;
      const quantity = Number(cp?.quantity ?? 0);
      seen.set(id, {
        id,
        storeProductId: String(sp?.id ?? ""),
        name: String(sp?.product?.name ?? id),
        unit: sp?.productVariant?.formattedPacksize ?? null,
        quantity,
        price: rupees(cp?.unitFinalSellingPrice ?? sp?.discountedSellingPrice),
        mrp: rupees(sp?.mrp),
        lineTotal: rupees(cp?.totalUnitFinalSellingPrice ?? Number(cp?.unitFinalSellingPrice) * quantity),
        image: image(sp?.productVariant),
      });
    }
  }
  return [...seen.values()];
}

const names = (list: Json[]): string =>
  list
    .map((p) => p?.storeProduct?.product?.name ?? p?.product?.name ?? p?.name ?? p?.productVariantId)
    .filter(Boolean)
    .join(", ");

/** The bill from a cfs/api/v1/cart/create reply. */
export function parseBill(c: Json): ZeptoBill {
  const items = cartLines(c);
  const lines: ZeptoBillLine[] = [];
  const itemTotal = rupees(c?.itemTotalAmount);
  const itemList = rupees(c?.itemTotalAmountPreDiscount);
  lines.push({
    type: "ITEM_TOTAL",
    label: "Item total",
    amount: itemTotal,
    ...(itemList > itemTotal ? { listAmount: itemList } : {}),
  });
  for (const f of [...(c?.fees ?? []), ...(c?.otherFees ?? [])]) {
    const amount = rupees(f?.amount);
    const list = rupees(f?.amountPreDiscount);
    if (!amount && !list) continue;
    lines.push({
      type: String(f?.type ?? "FEE"),
      label: String(f?.title ?? f?.type ?? "Fee").trim(),
      amount,
      ...(list > amount ? { listAmount: list } : {}),
    });
  }
  const coupon = rupees(c?.itemCouponDiscount) + rupees(c?.itemExternalCouponDiscount);
  if (coupon) lines.push({ type: "COUPON", label: "Coupon", amount: -coupon });
  const tip = rupees(c?.riderTip);
  if (tip) lines.push({ type: "RIDER_TIP", label: "Delivery partner tip", amount: tip });

  const issues: string[] = [];
  if (c?.isDeliverable === false) issues.push("Zepto doesn't deliver to this address right now");
  for (const r of c?.orderValidationResponse?.failureReasons ?? []) issues.push(String(r?.message ?? r?.reason ?? r));
  if (c?.oosProducts?.length) issues.push(`out of stock: ${names(c.oosProducts)}`);
  if (c?.unserviceableCartProducts?.length) issues.push(`not available here: ${names(c.unserviceableCartProducts)}`);
  if (c?.orderLimitBreached === true || c?.ordersPerDayLimitBreached === true) {
    issues.push("Zepto's order limit for this account is reached");
  }
  // A list of the cart's products that hit their per-day limit (empty when none).
  if (c?.skusPerDayLimitBreached?.length) issues.push(`daily limit reached for: ${names(c.skusPerDayLimitBreached)}`);
  if (!items.length) issues.push("the Zepto cart is empty");

  const grand = rupees(c?.grandTotalAmount);
  const total = rupees(c?.toPay ?? c?.grandTotalAmount);
  const eta = Number(c?.storeLevelCartProducts?.[0]?.displayEtaInMin ?? c?.etaInMinutes);
  const a = c?.userAddress;
  return {
    cartId: String(c?.cartId ?? ""),
    storeId: String(c?.storeId ?? ""),
    total,
    lines,
    items,
    address: a
      ? (a.displayText ?? ([a.flatDetails, a.googleFormattedAddress].filter(Boolean).join(", ") || null))
      : null,
    etaMinutes: Number.isFinite(eta) && eta > 0 ? eta : null,
    issues,
    walletApplied: Math.max(0, Math.round((grand - total) * 100) / 100),
    paymentFlow: c?.paymentDetails?.paymentFlow ?? null,
  };
}

/** An order from api/v2/order/ (order history). Unpaid QR orders show up as CANCELLED once the QR expires. */
export function parseOrder(o: Json): ZeptoOrder {
  return {
    orderId: String(o?.id ?? ""),
    status: String(o?.formattedStatus ?? o?.status ?? "?"),
    amount: o?.grandTotalAmount == null ? null : rupees(o.grandTotalAmount),
    placedAt: o?.placedTime ?? null,
    items: (o?.productsNamesAndCounts ?? []).map((i: Json) => ({
      name: String(i?.name ?? "?"),
      quantity: Number(i?.count ?? 1),
    })),
  };
}

export type ZeptoPayOutcome = "paid" | "failed";

/** Zepto's payment-id-status `data.status` → final outcome, or null while the payment is open. */
export function payOutcome(status: string | null | undefined): ZeptoPayOutcome | null {
  const s = String(status ?? "").toUpperCase();
  if (/SUCCE|COMPLET|PAID|CAPTURED|CHARGED/.test(s)) return "paid";
  if (/FAIL|DECLIN|REJECT|CANCEL|EXPIRE|ERROR/.test(s)) return "failed";
  return null;
}
