import type { BrowseResult } from "../services/catalog.js";
import type { Address, Cart, CategoryGroup, CategoryMatch, Product, ProductDetails } from "../types.js";

export const json = (o: unknown) => console.log(JSON.stringify(o, null, 2));

/** `soldOutHint`: Blinkit search hides sold-out items, so say how to see them when nothing matched. */
export function products(items: Product[], soldOutHint = false): void {
  if (!items.length) {
    const hint = soldOutHint ? " Sold-out items are hidden; add --out-of-stock to include them." : "";
    console.log(`No products found.${hint}`);
    return;
  }
  items.forEach((p, i) => {
    let price = `₹${p.price}`;
    if (p.discountPct) price += ` (MRP ₹${p.mrp}, -${p.discountPct}%)`;
    const tags = `${p.inStock ? "" : "  [OUT OF STOCK]"}${p.related ? "  [related]" : ""}`;
    console.log(`${String(i + 1).padStart(3)}. ${[p.name, p.unit, price].filter(Boolean).join(" · ")}${tags}`);
    console.log(`     id=${p.productId}  ${p.url}`);
  });
}

export function product(p: ProductDetails): void {
  console.log(
    `${[p.name, p.unit].filter(Boolean).join(" · ")} · ₹${p.price} (MRP ₹${p.mrp}) · ${p.inStock ? "in stock" : "OUT OF STOCK"}`,
  );
  if (p.breadcrumbs?.length) console.log(p.breadcrumbs.join(" > "));
  console.log(p.url);
  for (const [k, v] of Object.entries(p.attributes)) console.log(`  ${k}: ${v.replace(/\n/g, " ").slice(0, 200)}`);
}

export function cart(c: Cart): void {
  for (const o of c.outcomes ?? []) {
    if (o.outcome !== "applied" && o.outcome !== "removed") {
      console.log(`  ! ${o.productId}: ${o.outcome}${o.granted != null ? ` (got ${o.granted})` : ""}`);
    }
  }
  if (!c.items.length) {
    console.log("Cart is empty.");
    return;
  }
  for (const i of c.items) {
    console.log(
      `  ${i.quantity} × ${[i.name, i.unit].filter(Boolean).join(" · ")} @ ₹${i.price} = ₹${i.lineTotal}   (id=${i.productId})`,
    );
  }
  const b = c.bill;
  const extras = Object.entries(b.chargesBreakdown)
    .map(([k, v]) => `${k.replace(/_/g, " ")} ₹${v}`)
    .join(" · ");
  console.log(
    `  Items ₹${b.itemsTotal} (MRP ₹${b.itemsMrp}, saved ₹${b.productDiscount}) · delivery ₹${b.deliveryCharge}${extras ? ` · ${extras}` : ""}`,
  );
  console.log(`  To pay: ₹${b.toPay}  [${c.pricing} pricing]`);
  for (const s of c.delivery) console.log(`  Delivery: ${s.slot}`);
  if (c.checkout) console.log(`  ${c.checkout.nextStep}`);
}

export function addresses(list: Address[], currentId?: number): void {
  if (!list.length) {
    console.log("No saved addresses.");
    return;
  }
  for (const a of list) console.log(`${a.id === currentId ? "*" : " "} ${a.id}  [${a.label}] ${a.text}`);
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
