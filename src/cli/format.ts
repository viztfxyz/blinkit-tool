import { group, type MatchGroup } from "../core/match.js";
import type {
  Address,
  Bill,
  BrowseResult,
  Cart,
  CategoryGroup,
  CategoryMatch,
  Order,
  PlatformSession,
  Product,
  ProductDetails,
  Tagged,
} from "../core/types.js";
import type { FanOutFailure, PlatformDescriptor } from "../platforms/registry.js";

export const json = (o: unknown) => console.log(JSON.stringify(o, null, 2));

const money = (n: number) => `₹${n}`;
const widest = (xs: string[]) => Math.max(0, ...xs.map((x) => x.length));

/** `soldOutHint`: Blinkit search hides sold-out items, so say how to see them when nothing matched. */
export function products(items: Product[], soldOutHint = false): void {
  if (!items.length) {
    const hint = soldOutHint ? " Sold-out items are hidden; add --out-of-stock to include them." : "";
    console.log(`No products found.${hint}`);
    return;
  }
  items.forEach((p, i) => {
    let price = money(p.price);
    if (p.discountPct) price += ` (MRP ${money(p.mrp)}, -${p.discountPct}%)`;
    const tags = `${p.inStock ? "" : "  [OUT OF STOCK]"}${p.related ? "  [related]" : ""}`;
    console.log(`${String(i + 1).padStart(3)}. ${[p.name, p.unit, price].filter(Boolean).join(" · ")}${tags}`);
    console.log(`     id=${p.id}  ${p.url}`);
  });
}

export function product(p: ProductDetails): void {
  console.log(
    `${[p.name, p.unit].filter(Boolean).join(" · ")} · ${money(p.price)} (MRP ${money(p.mrp)}) · ${p.inStock ? "in stock" : "OUT OF STOCK"}`,
  );
  if (p.breadcrumbs?.length) console.log(p.breadcrumbs.join(" > "));
  console.log(`id=${p.id}  ${p.url}`);
  for (const [k, v] of Object.entries(p.attributes ?? {})) {
    console.log(`  ${k}: ${v.replace(/\n/g, " ").slice(0, 200)}`);
  }
}

export function cart(c: Cart): void {
  for (const i of c.issues) console.log(`  ! ${i}`);
  if (!c.items.length) {
    console.log("Cart is empty.");
    return;
  }
  for (const i of c.items) {
    console.log(
      `  ${i.quantity} × ${[i.name, i.unit].filter(Boolean).join(" · ")} @ ${money(i.price)} = ${money(i.lineTotal)}   (id=${i.id})`,
    );
  }
  const saved = c.itemsMrp > c.itemsTotal ? ` (MRP ${money(c.itemsMrp)})` : "";
  console.log(`  Items ${money(c.itemsTotal)}${saved} · total ${money(c.total)}`);
}

export function bill(b: Bill): void {
  const width = widest(b.lines.map((l) => l.label));
  for (const l of b.lines) {
    const was = l.listAmount != null ? ` (was ${money(l.listAmount)})` : "";
    console.log(`  ${l.label.padEnd(width)}  ${money(l.amount)}${was}`);
  }
  console.log(`  ${"To pay".padEnd(width)}  ${money(b.total)}`);
  if (b.address) console.log(`Deliver to: ${b.address}`);
  if (b.etaMinutes != null) console.log(`Arrives in about ${b.etaMinutes} min`);
  for (const i of b.issues) console.log(`  ! ${i}`);
  if (b.nextStep) console.log(`Pay with: ${b.nextStep}`);
}

export function orders(list: Order[]): void {
  if (!list.length) {
    console.log("No orders.");
    return;
  }
  for (const o of list) {
    const amount = o.amount != null ? ` · ${money(o.amount)}` : "";
    console.log(`${o.orderId}  ${o.status}${amount}${o.placedAt ? ` · ${o.placedAt}` : ""}`);
    for (const i of o.items) console.log(`  ${i.quantity} × ${i.name}`);
  }
}

/** Every platform's orders in one list, newest first; undated orders keep their platform's order. */
export function mergedOrders(list: Tagged<Order>[]): void {
  if (!list.length) {
    console.log("No orders.");
    return;
  }
  const width = widest(list.map((o) => o.platform));
  const when = (o: Order) => Date.parse(o.placedAt ?? "") || 0;
  for (const o of [...list].sort((a, b) => when(b) - when(a))) {
    const amount = o.amount != null ? ` · ${money(o.amount)}` : "";
    const placed = o.placedAt ? ` · ${o.placedAt}` : "";
    console.log(`${o.platform.padEnd(width)}  ${o.orderId}  ${o.status}${amount}${placed}`);
    for (const i of o.items) console.log(`${" ".repeat(width)}    ${i.quantity} × ${i.name}`);
  }
}

export function addresses(list: Address[]): void {
  if (!list.length) {
    console.log("No saved addresses.");
    return;
  }
  for (const a of list) {
    console.log(`${a.selected ? "*" : " "} [${a.label ?? "—"}] ${a.text}`);
    console.log(`    id=${a.id}`);
  }
}

export function session(platform: string, s: PlatformSession, width = 0): void {
  const where = s.deliverTo ? ` · [${s.deliverTo.label ?? "—"}] ${s.deliverTo.text}` : "";
  console.log(`${platform.padEnd(width)}  ${s.loggedIn ? "logged in" : "not logged in"}${where}`);
}

export function categoryTree(tree: CategoryGroup[]): void {
  for (const g of tree) {
    console.log(g.group);
    for (const c of g.categories) {
      console.log(`  ${String(c.id).padStart(8)}  ${c.name}  (${c.subcategories.length} subcategories)`);
    }
  }
}

export function categoryMatch(e: CategoryMatch): void {
  if (e.type === "group") {
    console.log(e.name);
    for (const c of e.categories) console.log(`  ${String(c.id).padStart(8)}  ${c.name}`);
  } else if (e.type === "category") {
    console.log(`${e.group} > ${e.name} (id ${e.id})`);
    for (const s of e.subcategories) console.log(`  ${String(s.id).padStart(8)}  ${s.name}`);
  } else {
    console.log(`${e.name} (subcategory ${e.id}) in ${e.group} > ${e.category}`);
  }
}

export function browse(r: BrowseResult): void {
  console.log([r.group, r.category, r.name].filter(Boolean).join(" > "));
  if (r.subcategories) console.log(`  subcategories: ${r.subcategories.map((s) => s.name).join(", ")}`);
  products(r.products);
}

/** What a fan-out couldn't reach, after the results, with the command that fixes each one. */
export function failures(errors: FanOutFailure[]): void {
  for (const e of errors) console.log(`! ${e.platform}: ${e.reason} — run \`${e.fix}\``);
}

export function platforms(list: { descriptor: PlatformDescriptor; state: string }[]): void {
  const width = widest(list.map((p) => p.descriptor.name));
  for (const { descriptor: d, state } of list) {
    console.log(`${d.name.padEnd(width)}  ${state}`);
    console.log(`${" ".repeat(width)}  ${d.capabilities.join(" ")}`);
  }
}

/** Per-platform lists, one block each (`--by-platform`). */
export function byPlatform(results: { platform: string; value: Product[] }[]): void {
  for (const { platform, value } of results) {
    console.log(`\n${platform}`);
    products(value);
  }
}

/**
 * The merged comparison: one block per likely-same product, cheapest in-stock row marked, and the
 * paste-ready add command for that row. Ids stay visible because the next step spends money, and a
 * group the matcher isn't sure about says so rather than quietly merging two different packs.
 */
export function merged(query: string, items: Tagged<Product>[], where?: string): void {
  const groups = group(items);
  const header = [query, where, `${new Set(items.map((i) => i.platform)).size} platforms`].filter(Boolean).join(" · ");
  console.log(header);
  if (!groups.length) {
    console.log("\nNo products found.");
    return;
  }
  const width = widest(items.map((i) => i.platform));
  for (const g of groups) {
    console.log(`\n${[g.title, g.unit].filter(Boolean).join(" · ")}${g.confident ? "" : "   [uncertain match]"}`);
    const best = g.offers.find((o) => o.inStock);
    for (const o of g.offers) {
      const mark = o === best ? "*" : " ";
      const discount = o.discountPct ? `MRP ${money(o.mrp)}  -${o.discountPct}%` : "";
      const row = [
        o.platform.padEnd(width),
        money(o.price).padEnd(6),
        discount.padEnd(16),
        (o.inStock ? "in stock" : "sold out").padEnd(9),
        o.id,
      ];
      console.log(`  ${mark} ${row.join(" ")}`);
    }
    if (best) console.log(`  handcart ${best.platform} cart add ${best.id}`);
  }
}

/** `--json` for a fan-out search: never grouped, so a machine consumer can't inherit a match mistake. */
export const taggedJson = (
  query: string,
  items: Tagged<Product>[],
  errors: FanOutFailure[],
): { query: string; results: Tagged<Product>[]; errors: FanOutFailure[] } => ({ query, results: items, errors });

export type { MatchGroup };
