import type { PayStatus } from "../../pay/status.js";

/** A Zepto product. Zepto's stable id is the product variant id (the `pvid` in zepto.com URLs). */
export interface ZeptoProduct {
  id: string;
  /** The listing at the current store; changes with the store, so the cart re-resolves it. */
  storeProductId: string;
  storeId: string | null;
  name: string;
  brand: string | null;
  unit: string | null;
  price: number;
  mrp: number;
  discountPct: number;
  inStock: boolean;
  maxQuantity: number | null;
  image: string | null;
  url: string;
}

export interface ZeptoCartLine {
  id: string;
  storeProductId: string;
  name: string;
  unit: string | null;
  quantity: number;
  price: number;
  mrp: number;
  lineTotal: number;
  image: string | null;
}

export interface ZeptoBillLine {
  /** Zepto's fee type (PACKAGING_FEE, DELIVERY_FEE…) or ours: ITEM_TOTAL, RIDER_TIP, COUPON. */
  type: string;
  label: string;
  amount: number;
  /** Before discounts, when Zepto shows a struck-out price (e.g. a waived ₹30 delivery fee). */
  listAmount?: number;
}

/** The priced cart for the selected address: Zepto's cart response. Building it does not place an order. */
export interface ZeptoBill {
  cartId: string;
  storeId: string;
  total: number;
  lines: ZeptoBillLine[];
  items: ZeptoCartLine[];
  address: string | null;
  etaMinutes: number | null;
  /** Problems Zepto reports (out of stock, not deliverable, order limits). Pay refuses while non-empty. */
  issues: string[];
  /** Zepto Cash / wallet the bill would use. Always 0 here (we send useZeptoCash: false); pay refuses otherwise. */
  walletApplied: number;
  /** Zepto's payment flow for this cart; pay needs "IPP" (Zepto's in-house payment page). */
  paymentFlow: string | null;
}

export type ZeptoCart = Pick<ZeptoBill, "items" | "total" | "issues"> & { itemsMrp: number; itemsTotal: number };

/** A saved address on the Zepto account. */
export interface ZeptoAddress {
  id: string;
  label: string | null;
  name: string | null;
  text: string;
  latitude: number;
  longitude: number;
  /** The address this tool shops for (kept locally; Zepto keeps the selection on the device). */
  selected: boolean;
}

export interface ZeptoOrder {
  orderId: string;
  status: string;
  amount: number | null;
  placedAt: string | null;
  items: { name: string; quantity: number }[];
}

export interface ZeptoPayStatus extends PayStatus {
  /** Zepto's order id (UUID). */
  zeptoOrderId?: string;
  paymentId?: string;
  /** When the UPI QR stops accepting payment, epoch ms. */
  qrExpiresAt?: number;
  /** Zepto's raw payment status, e.g. PENDING. */
  zeptoStatus?: string;
}
