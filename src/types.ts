// biome-ignore lint/suspicious/noExplicitAny: Blinkit's payloads are large, loosely-typed layout trees
export type Json = any;

export interface Coords {
  lat: number;
  lon: number;
}

export interface Location extends Coords {
  pincode?: string;
  address?: string;
  city?: string;
  serviceable?: boolean;
}

export interface SelectedAddress extends Coords {
  id: number;
  label: string;
  text: string;
}

export interface Product {
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

export interface ProductDetails extends Partial<Product> {
  productId: number;
  breadcrumbs?: string[];
  attributes: Record<string, string>;
}

export interface CartLine {
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

export interface Bill {
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

export interface Cart {
  cartId: number | null;
  pricing: Pricing;
  items: CartLine[];
  unavailableProducts: Json[];
  bill: Bill;
  delivery: { type: string; slot: string; date: string }[];
  outcomes?: LineOutcome[];
  checkout?: { cartId: number; state: string | null; nextStep: string };
}

export interface Address extends Partial<Coords> {
  id: number;
  label: string | null;
  name: string | null;
  text: string;
  serviceable?: boolean;
}

export interface Subcategory {
  id: number;
  name: string;
  l1CatIds: number[];
}

export interface Category {
  id: number;
  name: string;
  subcategories: Subcategory[];
}

export interface CategoryGroup {
  group: string;
  categories: Category[];
}

export type CategoryMatch =
  | { type: "group"; id: string; name: string; group: string; categories: { id: number; name: string }[] }
  | ({ type: "category"; group: string } & Category)
  | ({ type: "subcategory"; group: string; category: string } & Subcategory);

export interface Filters {
  maxPrice?: number;
  minPrice?: number;
  brand?: string;
  minDiscount?: number;
  inStock?: boolean;
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
