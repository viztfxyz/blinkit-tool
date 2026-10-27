/** Blinkit's own shapes. Product ids are numeric here; the descriptor stringifies them at the boundary. */
import type {
  Category,
  CategoryGroup,
  CategoryMatch,
  Coords,
  Filters,
  Json,
  Location,
  Subcategory,
} from "../../core/types.js";

/** Re-exported so the rest of this folder has one place to look for its types. */
export type { Category, CategoryGroup, CategoryMatch, Coords, Filters, Json, Location, Subcategory };

export interface SelectedAddress extends Coords {
  id: number;
  label: string;
  text: string;
}

export interface BlinkitProduct {
  productId: number;
  name: string;
  brand: string | null;
  unit: string | null;
  price: number;
  mrp: number;
  discountPct: number;
  inStock: boolean;
  inventory: number | null;
  merchantId: number | null;
  image: string | null;
  url: string;
  offer?: string | null;
  /** True for Blinkit's "related products" padding rather than direct matches. */
  related?: boolean;
  subcategory?: string;
}

export interface BlinkitProductDetails extends Partial<BlinkitProduct> {
  productId: number;
  breadcrumbs?: string[];
  attributes: Record<string, string>;
}

export interface BlinkitCartLine {
  productId: number;
  name: string;
  brand: string | null;
  unit: string | null;
  quantity: number;
  price: number;
  mrp: number;
  lineTotal: number;
  maxQuantity: number | null;
  unavailableQuantity: number;
  image: string | null;
}

export interface BlinkitBill {
  itemsMrp: number;
  itemsTotal: number;
  productDiscount: number;
  deliveryCharge: number;
  otherCharges: number;
  chargesBreakdown: Record<string, number>;
  promoDiscount: number;
  toPay: number;
  freeDeliveryAbove: number | null;
}

export type Pricing = "indicative" | "payable";

export interface LineOutcome {
  productId: number;
  outcome: "applied" | "partially_available" | "unavailable" | "removed" | "not_removed";
  quantity?: number;
  granted?: number;
}

export interface BlinkitCart {
  cartId: number | null;
  pricing: Pricing;
  items: BlinkitCartLine[];
  unavailableProducts: Json[];
  bill: BlinkitBill;
  delivery: { type: string; slot: string; date: string }[];
  outcomes?: LineOutcome[];
  checkout?: { cartId: number; state: string | null; nextStep: string };
}

export interface BlinkitAddress extends Partial<Coords> {
  id: number;
  label: string | null;
  name: string | null;
  text: string;
  serviceable?: boolean;
}

export interface SessionState {
  deviceId: string;
  authKey?: string;
  authKeyTs?: number;
  accessToken?: string;
  user?: { id: number; phone: string };
  pendingPhone?: string;
  location?: Location;
  address?: SelectedAddress;
  cartId?: number | null;
  /** productId -> quantity, mirrored from the server's view after every sync. */
  cart: Record<string, number>;
}
