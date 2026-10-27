/**
 * One entry per store. The CLI and the MCP server are written once against this contract and walk the
 * registry, so a new platform is a client, a parser and one `register` call — no front-end edits.
 */
import { HandcartError } from "../core/errors.js";
import type {
  Address,
  Bill,
  BrowseResult,
  Cart,
  CategoryGroup,
  CategoryMatch,
  Location,
  LocationInput,
  Order,
  PlatformSession,
  Product,
  SearchOptions,
} from "../core/types.js";
import type { PayOptions, PayStatus } from "../pay/index.js";
import { blinkit } from "./blinkit/index.js";
import { zepto } from "./zepto/index.js";

export type Capability =
  | "search"
  | "product"
  | "cart"
  | "checkout"
  | "pay"
  | "orders"
  | "addresses"
  | "login"
  | "categories"
  | "browse"
  | "locate";

export const CAPABILITIES = [
  "search",
  "product",
  "cart",
  "checkout",
  "pay",
  "orders",
  "addresses",
  "login",
  "categories",
  "browse",
  "locate",
] as const satisfies readonly Capability[];

export interface Platform {
  requestOtp(phone: string): Promise<{ sent: true; to: string }>;
  verifyOtp(code: string): Promise<unknown>;
  logout(): unknown;
  whoami(): Promise<PlatformSession>;
  addresses(): Promise<Address[]>;
  useAddress(which: string): Promise<Address>;
  search(query: string, opts?: SearchOptions): Promise<Product[]>;
  product(id: string): Promise<Product>;
  cart(): Promise<Cart>;
  setQuantity(id: string, quantity: number): Promise<Cart>;
  add(id: string, quantity?: number): Promise<Cart>;
  clear(): Promise<Cart>;
  checkout(): Promise<Bill>;
  orders?(): Promise<Order[]>;
  pay?(opts: PayOptions): Promise<PayStatus>;
  /**
   * Pay runs detached so it outlives the MCP server: the environment that points the child at this
   * same session, and the status file the child writes (its path also names the run's lock). All are
   * needed wherever `pay` is.
   */
  payEnv?(): Record<string, string>;
  payStatus?(): PayStatus;
  payStatusFile?(): string;
  // optional, Blinkit today
  categories?(): Promise<CategoryGroup[]>;
  findCategory?(name: string): Promise<CategoryMatch>;
  browse?(category: string, opts?: SearchOptions): Promise<BrowseResult>;
  locate?(pincode: string): Promise<Location>;
  setLocation?(where: LocationInput): Promise<Location>;
}

export interface PlatformDescriptor {
  name: string;
  label: string;
  /** Lazy: nothing is constructed, read or fetched until a command actually needs this platform. */
  create(): Platform;
  capabilities: Capability[];
}

/** Which members a declared capability promises, so a descriptor can't lie about what it supports. */
const REQUIRED_MEMBERS: Partial<Record<Capability, (keyof Platform)[]>> = {
  orders: ["orders"],
  pay: ["pay", "payEnv", "payStatus", "payStatusFile"],
  categories: ["categories", "findCategory"],
  browse: ["browse"],
  locate: ["locate", "setLocation"],
};

const registry = new Map<string, PlatformDescriptor>();
const live = new Map<string, Platform>();

function register(d: PlatformDescriptor): void {
  if (registry.has(d.name)) throw new Error(`platform ${d.name} is registered twice`);
  for (const c of d.capabilities) {
    if (!CAPABILITIES.includes(c)) throw new Error(`platform ${d.name} declares unknown capability ${c}`);
  }
  registry.set(d.name, d);
}

register(blinkit);
register(zepto);

export const platforms = (): PlatformDescriptor[] => [...registry.values()];

export function descriptor(name: string): PlatformDescriptor {
  const d = registry.get(name.toLowerCase());
  if (!d) throw new HandcartError(`unknown platform '${name}'; known: ${[...registry.keys()].join(", ")}`);
  return d;
}

export const supporting = (c: Capability): PlatformDescriptor[] =>
  platforms().filter((d) => d.capabilities.includes(c));

export const can = (d: PlatformDescriptor, c: Capability): boolean => d.capabilities.includes(c);

/** The platform's client, built once per process. The declared capabilities are checked here. */
export function client(name: string): Platform {
  const d = descriptor(name);
  let p = live.get(d.name);
  if (!p) {
    p = d.create();
    for (const c of d.capabilities) {
      for (const m of REQUIRED_MEMBERS[c] ?? []) {
        if (typeof p[m] !== "function") throw new Error(`platform ${d.name} declares ${c} but has no ${m}()`);
      }
    }
    live.set(d.name, p);
  }
  return p;
}

export interface FanOutFailure {
  platform: string;
  reason: string;
  /** The command that fixes it. */
  fix: string;
}

export interface FanOut<T> {
  results: { platform: string; value: T }[];
  errors: FanOutFailure[];
}

/**
 * Run `fn` on every platform that can do `capability`. A fan-out never fails wholesale: whatever
 * answered comes back alongside a per-platform reason and the command that fixes it.
 */
export async function fanOut<T>(
  capability: Capability,
  fn: (p: Platform, d: PlatformDescriptor) => Promise<T>,
): Promise<FanOut<T>> {
  const out: FanOut<T> = { results: [], errors: [] };
  const settled = await Promise.all(
    supporting(capability).map(async (d) => {
      try {
        return { d, value: await fn(client(d.name), d) };
      } catch (e) {
        return { d, error: e };
      }
    }),
  );
  for (const s of settled) {
    if ("error" in s) out.errors.push({ platform: s.d.name, reason: reasonOf(s.error), fix: fixFor(s.d, s.error) });
    else out.results.push({ platform: s.d.name, value: s.value });
  }
  return out;
}

export const reasonOf = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);

/** The command most likely to clear a fan-out failure: log in for anything auth-shaped, else doctor. */
export function fixFor(d: PlatformDescriptor, e: unknown): string {
  const reason = reasonOf(e).toLowerCase();
  if (/not logged in|session expired|log in|login|otp/.test(reason)) return `handcart ${d.name} login <phone>`;
  if (/address/.test(reason)) return `handcart ${d.name} address`;
  if (/location|pincode/.test(reason)) return `handcart location <pincode>`;
  return `handcart ${d.name} doctor`;
}
