/**
 * The shapes every platform speaks at the registry boundary. A platform's own wire types stay in its
 * folder; its descriptor converts. Product ids are strings everywhere here, whatever the store uses
 * underneath.
 */

// biome-ignore lint/suspicious/noExplicitAny: store payloads are large, loosely-typed layout trees
export type Json = any;

export interface Coords {
  lat: number;
  lon: number;
}

export interface LocationInput {
  pincode?: string;
  lat?: number;
  lon?: number;
}

export interface Location extends Coords {
  pincode?: string;
  address?: string;
  city?: string;
  serviceable?: boolean;
}

export const SORTS = ["relevance", "price", "price_desc", "discount"] as const;
export type Sort = (typeof SORTS)[number];

export interface Filters {
  maxPrice?: number;
  minPrice?: number;
  brand?: string;
  minDiscount?: number;
  inStock?: boolean;
}

export interface SearchOptions extends LocationInput, Filters {
  limit?: number;
  sort?: Sort;
  /** Include a store's loosely-related padding (flagged `related`). Default true. */
  includeRelated?: boolean;
  /** Also list sold-out products, after the in-stock ones. Slower where a store hides them. */
  includeOutOfStock?: boolean;
}

export interface Product {
  /** The id to pass back to this platform's `cart add` / `product`. */
  id: string;
  name: string;
  brand: string | null;
  unit: string | null;
  price: number;
  mrp: number;
  discountPct: number;
  inStock: boolean;
  image: string | null;
  url: string;
  /** True for a store's "related products" padding rather than a direct match. */
  related?: boolean;
}

export interface ProductDetails extends Product {
  breadcrumbs?: string[];
  attributes?: Record<string, string>;
}

export interface CartLine {
  id: string;
  name: string;
  unit: string | null;
  quantity: number;
  price: number;
  mrp: number;
  lineTotal: number;
  image: string | null;
}

export interface Cart {
  items: CartLine[];
  itemsMrp: number;
  itemsTotal: number;
  /** What the platform says the cart costs now; `itemsTotal` where it only prices at checkout. */
  total: number;
  /** Problems the platform reports: out of stock, quantity capped, not deliverable. */
  issues: string[];
}

export interface BillLine {
  /** The platform's own fee type (DELIVERY_FEE, handling_charge…) or ours: ITEM_TOTAL, COUPON. */
  type: string;
  label: string;
  amount: number;
  /** Before discounts, when the platform shows a struck-out price (e.g. a waived delivery fee). */
  listAmount?: number;
}

/** The payable bill for the cart and the selected address. Building it does not place an order. */
export interface Bill {
  total: number;
  lines: BillLine[];
  items: CartLine[];
  address: string | null;
  etaMinutes: number | null;
  /** Problems that block payment. */
  issues: string[];
  /** The exact command that pays this bill. */
  nextStep?: string;
}

export interface Address {
  id: string;
  label: string | null;
  name: string | null;
  text: string;
  /** The address this tool shops for on that platform. */
  selected?: boolean;
  serviceable?: boolean;
  lat?: number;
  lon?: number;
}

export interface Order {
  orderId: string;
  status: string;
  amount: number | null;
  placedAt: string | null;
  items: { name: string; quantity: number }[];
}

/** One line of `handcart whoami`: is this platform usable, and where does it deliver. */
export interface PlatformSession {
  loggedIn: boolean;
  deliverTo: { label: string | null; text: string } | null;
  /** Whatever else the platform wants shown, e.g. Blinkit's pricing tier and cart. */
  detail?: Record<string, Json>;
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

export interface BrowseResult {
  type: "category" | "subcategory";
  id: number;
  name: string;
  group: string;
  category?: string;
  subcategories?: { id: number; name: string }[];
  products: Product[];
}

/** Anything carried out of a fan-out, labelled with the platform it came from. */
export type Tagged<T> = T & { platform: string };
