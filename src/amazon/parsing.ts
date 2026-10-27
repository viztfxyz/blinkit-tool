import type { Json } from "../types.js";
import { AMAZON_BASE } from "./config.js";
import type { NowBill, NowBillLine, NowCart, NowCartLine, NowOrder, NowProduct } from "./types.js";

/**
 * Amazon money comes as `{amount}`, `{currency: {amount}}` or `{priceToPay: {currency: {amount}}}`
 * depending on the endpoint. Returns the first number found.
 */
export function money(...candidates: Json[]): number | null {
  for (const m of candidates) {
    const n = m?.amount ?? m?.currency?.amount ?? m?.priceToPay?.currency?.amount;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

const pct = (price: number, mrp: number) => (mrp > price ? Math.round((1 - price / mrp) * 100) : 0);

function image(p: Json): string | null {
  return p?.heroImage?.lowResImageUrl ?? p?.productImages?.[0]?.lowResImageUrl ?? null;
}

/** A product from search, recommendations or product lookup. */
export function parseProduct(p: Json): NowProduct {
  const price = money(p.price, p.buyingPrice) ?? 0;
  const mrp = money(p.listPrice) ?? price;
  return {
    asin: p.asin,
    name: p.title ?? p.shortTitle ?? p.asin,
    unit: p.packSize ?? null,
    price,
    mrp,
    discountPct: pct(price, mrp),
    inStock: p.availability?.type === "IN_STOCK",
    image: image(p),
    url: `${AMAZON_BASE}/dp/${p.asin}`,
    ...(p.offerId ? { offerId: p.offerId } : {}),
    ...(p.storeId ? { storeId: p.storeId } : {}),
  };
}

export function parseCart(c: Json): NowCart {
  const items: NowCartLine[] = (c?.cartItems ?? []).map((i: Json) => {
    const price = money(i.offerPrice, i.price) ?? 0;
    return {
      asin: i.asin,
      name: i.title ?? i.shortTitle ?? i.asin,
      unit: i.packSize ?? null,
      quantity: i.quantity,
      price,
      mrp: money(i.listPrice) ?? price,
      lineTotal: money(i.totalOfferPrice) ?? price * i.quantity,
      maxQuantity: i.maxAllowedQuantity ?? null,
      available: i.available !== false && (i.availabilityStatus ?? "IN_STOCK") === "IN_STOCK",
      image: image(i),
    };
  });
  return {
    items,
    itemsMrp: money(c?.totalListPrice) ?? 0,
    itemsTotal: money(c?.totalOfferPrice) ?? 0,
  };
}

const LINE_LABELS: Record<string, string> = {
  ITEM_TOTAL_TAX_INCLUSIVE: "Items",
  HANDLING_FEE_TAX_INCLUSIVE: "Handling fee",
  DELIVERY_FEE_TAX_INCLUSIVE: "Delivery fee",
  PROMOTIONS_APPLIED_TAX_INCLUSIVE: "Promotions",
  SPECIAL_PAYMENTS_GIFT_CARD_BALANCE: "Amazon Pay balance",
  MARKETPLACE_FEE_TAX_INCLUSIVE: "Marketplace fee",
};

/** Bill line where Amazon would show Amazon Pay balance being spent on this order. */
export const BALANCE_LINE = "SPECIAL_PAYMENTS_GIFT_CARD_BALANCE";

/** Expected before pay chooses Scan & Pay UPI; anything else in statusList blocks payment. */
const NO_PAYMENT_METHOD_YET = "INVALID_PAYMENT_METHOD";

export function parseBill(p: Json): NowBill {
  const lines: NowBillLine[] = (p?.billSummary?.shortBillSummary?.lineItems ?? [])
    .map((l: Json): NowBillLine => {
      const amount = money(l.ourPrice) ?? 0;
      const listAmount = money(l.listPrice);
      const label = String(l.displayLabel ?? LINE_LABELS[l.type] ?? l.type).replace(/:\s*$/, "");
      return { type: l.type, label, amount, ...(listAmount != null && listAmount !== amount ? { listAmount } : {}) };
    })
    .filter((l: NowBillLine) => l.amount !== 0 || l.listAmount != null);
  const balance = (p?.billSummary?.shortBillSummary?.lineItems ?? []).find((l: Json) => l.type === BALANCE_LINE);
  const eta = p?.preOrderETA?.relativeMinEtaInSeconds;
  return {
    purchaseId: p?.purchaseId,
    total: money(p?.grandTotal) ?? 0,
    lines,
    items: (p?.itemSummary?.lineItems ?? []).map((i: Json) => ({
      asin: i.asin,
      quantity: i.quantity,
      price: money(i.ourPrice) ?? 0,
      mrp: money(i.listPrice) ?? money(i.ourPrice) ?? 0,
    })),
    address: p?.selectedAddress?.lineDisplay ?? null,
    etaMinutes: typeof eta === "number" ? Math.round(eta / 60) : null,
    issues: (p?.statusList ?? [])
      .map((s: Json) => String(s.statusType))
      .filter((t: string) => t !== NO_PAYMENT_METHOD_YET),
    balanceApplied: Math.abs(money(balance?.ourPrice) ?? 0),
  };
}

export function parseOrder(o: Json): NowOrder {
  const groups: Json[] = o?.deliveryGroups ?? [];
  const tracking = groups[0]?.deliveryTrackingDetails;
  const eta = tracking?.eta?.minETA;
  return {
    orderId: o?.orderId,
    status: String(tracking?.header || tracking?.trackingStatus || "unknown"),
    payment: o?.paymentDetails?.chargeStatus ?? null,
    items: groups.flatMap((g) => (g.items ?? []).map((i: Json) => ({ name: i.asinTitle, quantity: i.quantity }))),
    etaMinutes: typeof eta === "number" && eta > 0 ? eta : null,
  };
}

/** The amount (rupees) inside a upi://pay intent, or null when it has none. */
export function upiAmount(intent: string): number | null {
  const am = new URL(intent.replace(/^upi:\/\//i, "https://upi/")).searchParams.get("am");
  const n = am == null ? Number.NaN : Number(am);
  return Number.isFinite(n) ? n : null;
}

export type NowPayOutcome = "paid" | "failed" | "timeout";

/**
 * Map Amazon's /aips/get-status reply to a final outcome, or null while the payment is still open.
 * Seen live: PENDING while open, and REJECTED (terminal) once an unpaid QR expired. A rejection
 * before `transactionExpiryTimeout` (unix seconds) is a real failure; at or after it, an expiry.
 */
export function payOutcome(reply: Json, now = Date.now()): NowPayOutcome | null {
  const s = String(reply?.status ?? "").toUpperCase();
  if (/SUCCE|COMPLET|PAID|CAPTURED/.test(s)) return "paid";
  if (!reply?.isTerminalStatus) return null;
  const expiry = Number(reply?.transactionExpiryTimeout) * 1000;
  if (Number.isFinite(expiry) && expiry > 0 && now >= expiry - 5000) return "timeout";
  return /FAIL|DECLIN|REJECT|DENIED|ERROR/.test(s) ? "failed" : "timeout";
}
