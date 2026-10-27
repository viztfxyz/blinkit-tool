/**
 * Cross-platform product grouping. Pure, deterministic, zero dependency: no I/O, no
 * network, no clock, no randomness. Same input always yields the same groups.
 *
 * Four stages, in order:
 *   1. quantity gate (hard)  2. brand gate (hard)  3. weighted score  4. mutual-best 1:1
 *
 * Measured on the 1,200-product corpus in test/fixtures/match/ at 97.1% precision and
 * 97.1% recall; `npm run bench:match` is the gate that keeps the weights honest.
 *
 * Measured and rejected, so nobody re-adds them:
 *   - title similarity alone (jaccard/dice/overlap/idf/trigram/levenshtein): 70.9-81.3% F1
 *   - MRP equality alone: 84.4% F1
 *   - variant markers derived from data instead of a word list: 95.8% F1
 *   - pack-count gate: 96.4% F1; combo-wording gate: 95.9% F1
 *   - local ONNX embeddings or LLM adjudication: unnecessary, rules reach 97% offline
 */

/**
 * The product fields the matcher reads. The shared `Product` in `core/types.ts` satisfies
 * this structurally, so callers pass `Product & { platform: string }` unchanged and
 * `group()` hands their own richer type straight back out through `MatchGroup.offers`.
 */
export interface MatchableProduct {
  id: string;
  name: string;
  brand: string | null;
  unit: string | null;
  price: number;
  mrp: number;
  inStock: boolean;
}

export type TaggedProduct = MatchableProduct & { platform: string };

export interface MatchGroup<T extends TaggedProduct = TaggedProduct> {
  /** Best display name for the group. */
  title: string;
  unit: string | null;
  /** Cheapest in-stock first, then out-of-stock. */
  offers: T[];
  /** false => the merge is uncertain and the caller should show a marker. */
  confident: boolean;
}

// ---------------------------------------------------------------- quantity

export type QtyClass = "vol" | "mass" | "count";

export interface Qty {
  /** Normalised to ml for `vol`, g for `mass`, pieces for `count`. */
  value: number;
  cls: QtyClass;
  /** How many packs the label mentions ("2 x 500 ml" => 2). Not gated on: a pack-count gate measured worse. */
  packs: number;
}

const UNIT_ALIASES: Record<string, string[]> = {
  ml: ["ml", "milliliter", "millilitre"],
  l: ["l", "ltr", "litre", "liter", "lt"],
  g: ["g", "gm", "gms", "gram", "grams"],
  kg: ["kg", "kgs", "kilogram"],
  pc: ["pc", "pcs", "piece", "pieces", "unit", "units", "nos", "no"],
};

const TO_BASE: Record<string, [number, QtyClass]> = {
  ml: [1, "vol"],
  l: [1000, "vol"],
  g: [1, "mass"],
  kg: [1000, "mass"],
  pc: [1, "count"],
};

function unitKey(raw: string): string | null {
  const u = raw.toLowerCase().replace(/[.]/g, "");
  for (const [key, aliases] of Object.entries(UNIT_ALIASES)) if (aliases.includes(u)) return key;
  return null;
}

/**
 * Parse the first usable "<number> <unit>" out of the given strings, which are joined in
 * order — pass the structured `unit` field first and the name second, so a clean label wins
 * over a size mentioned in marketing copy.
 *
 * Handles the shapes the real corpus actually uses: `500 ml`, `1 ltr`, `1 pack (500 ml)`,
 * `1 pc (1 L)`, `6 pcs`, `2 x 500 ml`, `1 pack (5 x 125 g)`, `pack of 6`, and sizes glued
 * into a name like `Fresh Tender Coconut Water,1 Pc`.
 */
export function parseQty(...sources: (string | null | undefined)[]): Qty | null {
  const s = sources.filter(Boolean).join(" ").toLowerCase();

  // "pack of 6" multiplies a later per-unit size; on its own it is a piece count.
  let packs = 1;
  const packOf = s.match(/pack\s*of\s*(\d+)/);
  if (packOf) packs = Number(packOf[1]);

  // "2 x 500 ml" / "5 x 125 g" — an explicit multipack, so the total is what we compare.
  const nx = s.match(/(\d+)\s*[x*×]\s*(\d+(?:\.\d+)?)\s*([a-z]+)/);
  if (nx) {
    const key = unitKey(nx[3]);
    if (key) {
      const [factor, cls] = TO_BASE[key];
      return { value: Number(nx[1]) * Number(nx[2]) * factor, cls, packs: Number(nx[1]) };
    }
  }

  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    const key = unitKey(m[2]);
    if (!key) continue; // e.g. the "1 pack" in "1 pack (500 ml)" — keep looking
    const [factor, cls] = TO_BASE[key];
    // "pack of 6" x "500 ml" is 3000 ml, but "pack of 6" x "6 pcs" is not 36 pieces.
    const mult = packs > 1 && cls !== "count" ? packs : 1;
    return { value: Number(m[1]) * factor * mult, cls, packs };
  }

  if (packs > 1) return { value: packs, cls: "count", packs };
  return null;
}

/** The hard gate: a 500 ml pouch must never look like a cheaper 1 L carton. */
export function qtyEq(a: Qty | null, b: Qty | null): boolean {
  return !!a && !!b && a.cls === b.cls && Math.abs(a.value - b.value) < 1e-6;
}

// ---------------------------------------------------------------- tokens

/** Packaging, filler and unit words that carry no product identity. */
const NOISE = new Set(
  (
    "pack packet pouch bottle box tin can jar cup tetra pak combo refill fresh pc pcs piece pieces of " +
    "and with the for in ml l ltr litre g gm kg pack-of per each x - | & india indias imported " +
    "premium"
  ).split(" "),
);

/** Hindi-English and spelling variants collapsed onto one spelling. */
const SYNONYMS = new Map<string, string>(
  Object.entries({
    dahi: "curd",
    namak: "salt",
    chai: "tea",
    doodh: "milk",
    atta: "flour",
    tel: "oil",
    arhar: "toor",
    tuver: "toor",
    tur: "toor",
    daal: "dal",
    mithu: "salt",
    chokha: "rice",
    godihittu: "flour",
    sendha: "rock",
    kapasiya: "cottonseed",
    suryamukhi: "sunflower",
    sing: "groundnut",
    crisps: "chips",
    namkeen: "snack",
    snacks: "snack",
    biscuits: "biscuit",
    bar: "soap",
    bars: "soap",
    bathing: "bath",
    moisturising: "moisturizing",
    iodised: "iodized",
    homogenised: "homogenized",
    standardised: "standardized",
    flavoured: "flavored",
    roti: "bread",
    rotis: "bread",
    loaf: "bread",
  }),
);

/**
 * Words that name a variant rather than a product: present on exactly one side, the two
 * SKUs are different things (Taaza vs Gold, Classic vs Magic Masala). Hand-written on
 * purpose — deriving this list from the corpus scored 95.8% F1, i.e. worse.
 */
const VARIANT = new Set(
  (
    "zero sugarfree free lite superlite combo variety saver organic whole multigrain sev aloo garlic " +
    "oily oiled plain gold select premium pro express matic crustless sliced brown white lactose " +
    "skimmed toned cream buffalo cow camel a2 gir banni pink rock black iron losodium peptide " +
    "dandruff menthol mint purple peppermint neem lime cologne icy original skincare tomato onion " +
    "masala double special cuppa chilly elaichi agni biryani pulav dubar classic everyday daily " +
    "rozana super delight taaza moti shakti malai tofu khoa basundi koko calci kadai"
  ).split(" "),
);

/** British/American -ise/-ize, so only one spelling needs a synonym entry. */
const deAmericanise = (t: string) => t.replace(/ized$/, "ised").replace(/izing$/, "ising");

/**
 * Identity tokens for a product name: brand words, bracketed asides, sizes, packaging nouns
 * and one-character leftovers dropped, then Hindi-English and spelling variants collapsed.
 * The brand is removed because it is gated on separately and would otherwise dominate the
 * cosine for every product of the same brand.
 */
export function canonTokens(name: string, brand?: string | null): string[] {
  let s = ` ${name.toLowerCase()} `;
  if (brand) {
    for (const w of brand
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)) {
      s = s.replaceAll(` ${w} `, " ");
    }
  }
  s = s.replace(/\(.*?\)/g, " ").replace(/\d+(?:\.\d+)?\s*[a-z]*/g, " ");
  const toks = s.split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !NOISE.has(t));
  const canon = toks.map((t) => SYNONYMS.get(t) ?? SYNONYMS.get(deAmericanise(t)) ?? t);
  return [...new Set(canon)];
}

export function brandKey(brand: string | null | undefined): string | null {
  return brand ? brand.toLowerCase().replace(/[^a-z0-9]/g, "") : null;
}

/** Variant words present on exactly one side. */
export function variantConflict(a: string[], b: string[]): number {
  const A = new Set(a.filter((t) => VARIANT.has(t)));
  const B = new Set(b.filter((t) => VARIANT.has(t)));
  let n = 0;
  for (const t of A) if (!B.has(t)) n++;
  for (const t of B) if (!A.has(t)) n++;
  return n;
}

// ---------------------------------------------------------------- similarity

export function trigrams(s: string): string[] {
  const t = ` ${s.replace(/[^a-z0-9]+/g, " ").trim()} `;
  const g = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
  return [...g];
}

/** Sørensen-Dice over two token/gram sets. */
export function dice(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return A.size + B.size ? (2 * i) / (A.size + B.size) : 0;
}

export type IdfFn = (token: string) => number;

/** Cosine over token sets weighted by idf, so "milk" counts for less than "banni". */
export function idfCosine(a: string[], b: string[], idf: IdfFn): number {
  const A = new Set(a);
  const B = new Set(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const t of A) {
    const w = idf(t);
    na += w * w;
    if (B.has(t)) dot += w * w;
  }
  for (const t of B) {
    const w = idf(t);
    nb += w * w;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Smoothed idf over the documents being grouped. Built from the call's own input, which is
 * what keeps `match.ts` free of I/O: one query's worth of results is enough to learn that
 * "milk" is common and "banni" is not.
 */
export function buildIdf(docs: string[][]): IdfFn {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return (t) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;
}

// ---------------------------------------------------------------- scoring

/** The measured configuration. Changing any of these invalidates the benchmark. */
export const WEIGHTS = {
  /** Trigram dice over the raw names: catches word order and partial words. */
  trigram: 0.45,
  /** Idf cosine over canonical tokens: catches synonyms and ignores filler. */
  idf: 0.55,
  /** MRP is printed on the pack by law and identical in every store — the strongest signal. */
  mrpEqual: 0.3,
  /** Different MRPs on the same quantity usually means a different SKU. */
  mrpDiffer: 0.18,
  /** Per variant word present on only one side. */
  variant: 0.12,
} as const;

/**
 * Pairs at or above this score may group. 0.36 gives 97.1% precision and 97.1% recall on
 * the fixture corpus; `npm run bench:match` prints the neighbouring thresholds.
 */
export const THRESHOLD = 0.36;

/**
 * Below this score a merge is reported as `confident: false` (still grouped, not split).
 * 0.65 flags every known false positive at the cost of ~1 in 8 correct merges; see
 * `npm run bench:match`.
 */
export const CONFIDENT_FLOOR = 0.65;

/** A product with everything the gates and the score need, computed once. */
export interface Prepared<T extends TaggedProduct = TaggedProduct> {
  item: T;
  qty: Qty | null;
  brand: string | null;
  tokens: string[];
  grams: string[];
}

export function prepare<T extends TaggedProduct>(item: T): Prepared<T> {
  return {
    item,
    qty: parseQty(item.unit, item.name),
    brand: brandKey(item.brand),
    tokens: canonTokens(item.name, item.brand),
    grams: trigrams(item.name.toLowerCase()),
  };
}

/** True when the hard gates allow the pair to be considered at all. */
export function gatesPass(a: Prepared, b: Prepared): boolean {
  if (a.item.platform === b.item.platform) return false; // two SKUs in one store stay apart
  if (!qtyEq(a.qty, b.qty)) return false;
  if (a.brand && b.brand && a.brand !== b.brand) return false;
  return true;
}

/** The weighted score for a gated pair. Unbounded; compare against `THRESHOLD`. */
export function score(a: Prepared, b: Prepared, idf: IdfFn): number {
  const mrpEqual = a.item.mrp > 0 && a.item.mrp === b.item.mrp;
  return (
    WEIGHTS.trigram * dice(a.grams, b.grams) +
    WEIGHTS.idf * idfCosine(a.tokens, b.tokens, idf) +
    (mrpEqual ? WEIGHTS.mrpEqual : -WEIGHTS.mrpDiffer) -
    WEIGHTS.variant * variantConflict(a.tokens, b.tokens)
  );
}

// ---------------------------------------------------------------- grouping

export interface ScoredPair {
  a: number;
  b: number;
  score: number;
}

/**
 * Every gated pair above the threshold, highest score first. Ties break on input order so
 * the result is deterministic.
 */
export function candidatePairs(prepared: Prepared[], idf: IdfFn, threshold = THRESHOLD): ScoredPair[] {
  const pairs: ScoredPair[] = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      if (!gatesPass(prepared[i], prepared[j])) continue;
      const s = score(prepared[i], prepared[j], idf);
      if (s >= threshold) pairs.push({ a: i, b: j, score: s });
    }
  }
  return pairs.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
}

/**
 * Group tagged products from several platforms into likely-same-product groups.
 *
 * Every input item comes back in exactly one group; an item that matches nothing is a group
 * of one. Grouping is display only — each offer keeps its own platform and product id, so a
 * wrong merge can never cause a purchase on the wrong platform.
 *
 * The mutual-best assignment is scoped to this one call, i.e. one query's worth of results.
 * Applying it across queries instead silently destroys recall, because a product's best
 * partner in some unrelated query steals it from its real partner here.
 */
export function group<T extends TaggedProduct>(
  items: T[],
  /** Only for the benchmark, which sweeps the threshold through this same code path. */
  opts: { threshold?: number } = {},
): MatchGroup<T>[] {
  const prepared = items.map(prepare);
  const idf = buildIdf(prepared.map((p) => p.tokens));

  // Union-find over accepted pairs. A group holds at most one offer per platform, which is
  // the 1:1 part: taking the highest-scoring pair first, a product that has already claimed
  // a partner on some platform cannot claim a second one there.
  const parent = prepared.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) [i, parent[i]] = [parent[i], r];
    return r;
  };
  const platforms = new Map<number, Set<string>>();
  for (let i = 0; i < prepared.length; i++) platforms.set(i, new Set([items[i].platform]));
  /** Lowest link score in each component, so a 3-way group is only as confident as its weakest link. */
  const weakest = new Map<number, number>();

  for (const pair of candidatePairs(prepared, idf, opts.threshold ?? THRESHOLD)) {
    const ra = find(pair.a);
    const rb = find(pair.b);
    if (ra === rb) continue;
    const pa = platforms.get(ra) as Set<string>;
    const pb = platforms.get(rb) as Set<string>;
    let clash = false;
    for (const p of pb) if (pa.has(p)) clash = true;
    if (clash) continue;

    parent[rb] = ra;
    for (const p of pb) pa.add(p);
    platforms.delete(rb);
    weakest.set(
      ra,
      Math.min(weakest.get(ra) ?? Number.POSITIVE_INFINITY, weakest.get(rb) ?? Number.POSITIVE_INFINITY, pair.score),
    );
    weakest.delete(rb);
  }

  // Components in first-seen input order, members in input order.
  const members = new Map<number, number[]>();
  for (let i = 0; i < prepared.length; i++) {
    const r = find(i);
    const list = members.get(r);
    if (list) list.push(i);
    else members.set(r, [i]);
  }

  return [...members.entries()].map(([root, idx]) => {
    const offers = [...idx].sort(
      (i, j) => Number(items[j].inStock) - Number(items[i].inStock) || items[i].price - items[j].price || i - j,
    );
    const link = weakest.get(root);
    return {
      // Shortest name reads best: it is the one without the marketing tail.
      title: pick(idx, (i) => items[i].name) ?? items[idx[0]].name,
      unit: pick(idx, (i) => items[i].unit) ?? null,
      offers: offers.map((i) => items[i]),
      confident: link === undefined || link >= CONFIDENT_FLOOR,
    };
  });
}

/** Shortest non-empty value in input order, for a stable, readable group label. */
function pick(idx: number[], get: (i: number) => string | null): string | null {
  let best: string | null = null;
  for (const i of idx) {
    const v = get(i);
    if (v && (best === null || v.length < best.length)) best = v;
  }
  return best;
}
