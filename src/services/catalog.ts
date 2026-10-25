import { paths, type Sort } from "../core/config.js";
import { BlinkitError } from "../core/errors.js";
import type { Core } from "../core/session.js";
import { readJson, writeJson } from "../core/storage.js";
import type {
  CategoryGroup,
  CategoryMatch,
  Coords,
  Filters,
  Json,
  Product,
  ProductDetails,
  Subcategory,
} from "../types.js";
import { findKey, fromCartItem, parseCard, refine, scanSize, walkWidgets } from "./parsing.js";

export interface Where {
  pincode?: string;
  lat?: number;
  lon?: number;
}

export interface SearchOptions extends Where, Filters {
  limit?: number;
  sort?: Sort;
  /** Include Blinkit's "related products" padding (flagged `related`). Default true. */
  includeRelated?: boolean;
  /**
   * Also list sold-out products, after the in-stock ones (up to `limit` more). Blinkit's search
   * omits them and listings put them last, so this pages whole listings: slower.
   */
  includeOutOfStock?: boolean;
}

export interface BrowseResult {
  type: "category" | "subcategory";
  id: number;
  name: string;
  group: string;
  category?: string;
  subcategories?: { id: number; name: string }[];
  products: Product[];
}

/** Stop paging a listing after this many products (a big subcategory has a few hundred). */
const MAX_LISTING = 600;

/** Run `fn` over `items`, at most `n` at a time, keeping order. */
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Every word of the query (ignoring a plural "s") appears in the product's name or brand. */
function matchesQuery(p: Product, query: string): boolean {
  const hay = `${p.name} ${p.brand ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)
    .every((w) => hay.includes(w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

const filtersOf = (o: Filters): Filters => ({
  maxPrice: o.maxPrice,
  minPrice: o.minPrice,
  brand: o.brand,
  minDiscount: o.minDiscount,
  inStock: o.inStock,
});

export class Catalog {
  constructor(private core: Core) {}

  async search(query: string, opts: SearchOptions = {}): Promise<Product[]> {
    const { limit = 24, sort = "relevance", includeRelated = true } = opts;
    const loc = await this.core.resolveLocation(opts);
    const filters = filtersOf(opts);
    const path = `/v1/layout/search?q=${encodeURIComponent(query)}&search_type=type_to_search`;
    const items = await this.collect(path, loc, scanSize(limit, sort, filters), includeRelated);
    const found = refine(items, limit, sort, filters);
    if (!opts.includeOutOfStock || filters.inStock) return found;
    const seen = new Set(items.map((p) => p.productId));
    const soldOut = (await this.soldOutMatches(query, items, loc)).filter((p) => !seen.has(p.productId));
    return [...found, ...refine(soldOut, limit, sort, filters)];
  }

  /**
   * Blinkit's search never returns sold-out products. Find them in the listings of the
   * subcategories the top direct matches belong to (or one named like the query).
   */
  private async soldOutMatches(query: string, items: Product[], loc: Coords): Promise<Product[]> {
    const direct = items.filter((p) => !p.related).slice(0, 3);
    const crumbs = await mapLimit(direct, 3, (p) =>
      this.product(p.productId, loc).then(
        (d) => d.breadcrumbs,
        () => undefined,
      ),
    );
    const subs = new Map<number, Subcategory>();
    for (const c of crumbs) {
      const s = c && (await this.subcategoryAt(c));
      if (s) subs.set(s.id, s);
    }
    if (!subs.size) {
      const e = await this.findCategory(query).catch(() => undefined);
      if (e?.type === "subcategory") subs.set(e.id, e);
    }
    const l1s = [...subs.values()].slice(0, 2).flatMap((s) => s.l1CatIds);
    const lists = await mapLimit(l1s, 3, (l1) =>
      this.collect(`/v1/layout/listing_widgets?l1_cat=${l1}`, loc, MAX_LISTING),
    );
    const out = new Map<number, Product>();
    for (const p of lists.flat()) if (!p.inStock && matchesQuery(p, query)) out.set(p.productId, p);
    return [...out.values()];
  }

  /** The subcategory a product page's breadcrumbs (group > category > subcategory) point at. */
  private async subcategoryAt(crumbs: string[]): Promise<Subcategory | undefined> {
    const [sub, cat] = [crumbs.at(-1), crumbs.at(-2)].map((x) => x?.trim().toLowerCase());
    if (!sub) return undefined;
    let loose: Subcategory | undefined;
    for (const g of await this.categories()) {
      for (const c of g.categories) {
        const s = c.subcategories.find((x) => x.name.toLowerCase() === sub);
        if (s && c.name.toLowerCase() === cat) return s;
        loose ??= s;
      }
    }
    return loose;
  }

  /** Page through a search/listing layout, returning parsed product cards. */
  private async collect(path: string | undefined, loc: Coords, scan: number, includeRelated = true) {
    const out: Product[] = [];
    const seen = new Set<number>();
    let related = false;
    while (path && out.length < scan) {
      const resp = (await this.core.req("POST", path, { loc, json: {} })).response ?? {};
      const snippets: Json[] = resp.snippets ?? [];
      for (const sn of snippets) {
        const d = sn.data ?? {};
        const isRelatedHeader = sn.widget_type === "image_text_vr_type_header" && /related/i.test(d.title?.text ?? "");
        if (isRelatedHeader) {
          related = true; // Blinkit pads results with loosely related products past this header
          if (!includeRelated) break;
          continue;
        }
        const p = parseCard(d);
        if (p && !seen.has(p.productId)) {
          seen.add(p.productId);
          p.related = related;
          out.push(p);
        }
      }
      if ((related && !includeRelated) || !snippets.length) break;
      path = resp.pagination?.next_url;
    }
    return out;
  }

  async product(productId: number, where: Where = {}): Promise<ProductDetails> {
    const loc = await this.core.resolveLocation(where);
    const resp = (await this.core.req("POST", `/v1/layout/product/${productId}`, { loc, json: {} })).response ?? {};
    let result: ProductDetails = { productId, attributes: {} };
    for (const sn of resp.snippets ?? []) {
      const d = sn.data ?? {};
      if (sn.widget_type === "product_atc_strip") {
        const item = findKey(d, "cart_item");
        if (item) result = { ...result, ...fromCartItem(item, d) };
      } else if (sn.widget_type === "horizontal_text_list_snippet" && !result.breadcrumbs) {
        result.breadcrumbs = (d.horizontal_item_list ?? []).map((x: Json) => x.title?.text).filter(Boolean);
      }
    }
    for (const node of walkWidgets(resp, "b_image_text_snippet_type_3")) {
      const t = node.title?.text;
      const v = node.subtitle?.text;
      if (t && v && !(t in result.attributes)) result.attributes[t] = String(v).trim();
    }
    if (!result.name) throw new BlinkitError(`product ${productId} not available at this location`);
    return result;
  }

  // ---------- categories ----------

  /** The app's category tree: groups → categories → subcategories (cached for an hour). */
  async categories(): Promise<CategoryGroup[]> {
    const cached = readJson<{ ts: number; tree: CategoryGroup[] }>(paths.categories);
    if (cached?.tree?.length && cached.ts > Date.now() - 3600_000) return cached.tree;
    const data = await this.core.req("POST", "/v1/layout/tag_collections", { json: { fetch_categories: true } });
    const tree: CategoryGroup[] = Object.entries<Json>(data.CategoryCollectionsMap ?? {}).map(([tag, grp]) => ({
      group: String(grp.DisplayName || tag).trim(),
      categories: (grp.Collection ?? []).map((c: Json) => ({
        id: c.id,
        name: String(c.display_name).trim(),
        subcategories: (c.groupings ?? [])
          .map((g: Json) => ({
            id: g.id,
            name: String(g.name).trim(),
            l1CatIds: (g.collection_filters ?? []).flatMap((f: Json) => f.l1_cat_id ?? []),
          }))
          .filter((s: Subcategory) => s.l1CatIds.length),
      })),
    }));
    writeJson(paths.categories, { ts: Date.now(), tree });
    return tree;
  }

  /** Resolve a group, category or subcategory by id or name (exact, then partial match). */
  async findCategory(nameOrId: string | number): Promise<CategoryMatch> {
    const q = String(nameOrId).trim().toLowerCase();
    const entries: CategoryMatch[] = [];
    for (const g of await this.categories()) {
      entries.push({
        type: "group",
        id: g.group,
        name: g.group,
        group: g.group,
        categories: g.categories.map((c) => ({ id: c.id, name: c.name })),
      });
      for (const c of g.categories) {
        entries.push({ type: "category", group: g.group, ...c });
        for (const s of c.subcategories) entries.push({ type: "subcategory", group: g.group, category: c.name, ...s });
      }
    }
    const tests = [
      (e: CategoryMatch) => String(e.id) === q,
      (e: CategoryMatch) => e.name.toLowerCase() === q,
      (e: CategoryMatch) => e.name.toLowerCase().includes(q),
    ];
    for (const test of tests) {
      const hits = entries.filter(test);
      if (hits.length === 1) return hits[0];
      if (hits.length) {
        const cats = hits.filter((e) => e.type === "category"); // a category beats same-named subcategories
        if (cats.length === 1) return cats[0];
        throw new BlinkitError(
          "ambiguous, pick one: " +
            hits
              .slice(0, 15)
              .map((e) => `${e.id} ${e.type} '${e.name}'${e.type === "subcategory" ? ` in ${e.category}` : ""}`)
              .join("; "),
        );
      }
    }
    throw new BlinkitError(`no category or subcategory matches '${nameOrId}'; see \`blinkit categories\``);
  }

  /** Products in a subcategory, or interleaved across all subcategories of a category. */
  async browse(category: string | number, opts: SearchOptions = {}): Promise<BrowseResult> {
    const { limit = 24, sort = "relevance" } = opts;
    const loc = await this.core.resolveLocation(opts);
    const e = await this.findCategory(category);
    if (e.type === "group") {
      throw new BlinkitError(`'${e.name}' is a group; pick a category: ${e.categories.map((c) => c.name).join(", ")}`);
    }
    const subs = e.type === "subcategory" ? [e] : e.subcategories;
    const filters = filtersOf(opts);
    const withSoldOut = !!opts.includeOutOfStock && !filters.inStock;
    const scan = scanSize(limit, sort, filters);
    // sold-out products come last in a listing, so finding them means paging it to the end
    const per = withSoldOut ? MAX_LISTING : subs.length === 1 ? scan : Math.max(3, Math.ceil(scan / subs.length));
    const lists = await mapLimit(subs, 4, async (s) => {
      const list: Product[] = [];
      for (const l1 of s.l1CatIds) {
        for (const p of await this.collect(`/v1/layout/listing_widgets?l1_cat=${l1}`, loc, per)) {
          list.push({ ...p, subcategory: s.name });
        }
      }
      return list;
    });
    // interleave subcategories so a whole-category listing isn't just the first one
    const items: Product[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) {
      for (const l of lists) {
        const p = l[i];
        if (p && !seen.has(p.productId)) {
          seen.add(p.productId);
          items.push(p);
        }
      }
    }
    return {
      type: e.type,
      id: e.id,
      name: e.name,
      group: e.group,
      ...(e.type === "category"
        ? { subcategories: subs.map((s) => ({ id: s.id, name: s.name })) }
        : { category: e.category }),
      products: withSoldOut
        ? [
            ...refine(
              items.filter((p) => p.inStock),
              limit,
              sort,
              filters,
            ),
            ...refine(
              items.filter((p) => !p.inStock),
              limit,
              sort,
              filters,
            ),
          ]
        : refine(items, limit, sort, filters),
    };
  }
}
