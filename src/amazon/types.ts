import type { PayStatus } from "../pay/status.js";

/** An Amazon Now product. Amazon identifies products by ASIN (a 10-character string), not a number. */
export interface NowProduct {
  asin: string;
  name: string;
  unit: string | null;
  price: number;
  mrp: number;
  discountPct: number;
  inStock: boolean;
  image: string | null;
  url: string;
  /** Needed to add the product to the cart; comes from search, product lookup or the cart. */
  offerId?: string;
  storeId?: string;
}

export interface NowCartLine {
  asin: string;
  name: string;
  unit: string | null;
  quantity: number;
  price: number;
  mrp: number;
  lineTotal: number;
  maxQuantity: number | null;
  available: boolean;
  image: string | null;
}

export interface NowCart {
  items: NowCartLine[];
  itemsMrp: number;
  itemsTotal: number;
}

export interface NowBillLine {
  /** Amazon's line type, e.g. ITEM_TOTAL_TAX_INCLUSIVE, DELIVERY_FEE_TAX_INCLUSIVE. */
  type: string;
  label: string;
  amount: number;
  /** Before discounts, when Amazon shows a struck-out price (e.g. a waived ₹30 delivery fee). */
  listAmount?: number;
}

/** The payable bill from Amazon's checkout session. Building it does not place an order. */
export interface NowBill {
  purchaseId: string;
  total: number;
  lines: NowBillLine[];
  items: { asin: string; quantity: number; price: number; mrp: number }[];
  address: string | null;
  etaMinutes: number | null;
  /**
   * Problems Amazon reports for this checkout other than "no payment method chosen yet", which is
   * expected before `pay` picks Scan & Pay UPI. Pay refuses while this is non-empty.
   */
  issues: string[];
  /** Amazon Pay balance the bill would use. Always 0 here; pay refuses otherwise. */
  balanceApplied: number;
}

/** A saved address on the Amazon account. */
export interface NowAddress {
  id: string;
  label: string | null;
  name: string | null;
  text: string;
  pincode: string | null;
  /** Amazon Now delivers here (Amazon's `isEnabled`; unserved addresses show "Not served"). */
  serviceable: boolean;
  /** The address Amazon Now is currently shopping for. */
  selected: boolean;
  /** The account's default address on amazon.in (not necessarily served by Amazon Now). */
  isDefault: boolean;
}

export interface NowOrder {
  orderId: string;
  /** What Amazon shows on the order, e.g. "Order cancelled", "Arriving in 9 mins". */
  status: string;
  /** PENDING until the UPI payment lands. */
  payment: string | null;
  items: { name: string; quantity: number }[];
  etaMinutes: number | null;
}

export interface NowPayStatus extends PayStatus {
  /** Amazon's purchase id ("404-…"). */
  purchaseId?: string;
  /** When the UPI QR stops accepting payment, epoch ms. */
  qrExpiresAt?: number;
  /** Amazon's raw payment status, e.g. PENDING. */
  amazonStatus?: string;
}
