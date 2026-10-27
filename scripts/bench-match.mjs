#!/usr/bin/env node
/**
 * Benchmark src/core/match.ts against the real captured corpus in test/fixtures/match/.
 *
 * Run with `npm run bench:match`. Needs a Node that strips TypeScript types on import
 * (>= 22.18); otherwise run it as `npx tsx scripts/bench-match.mjs`.
 *
 * The candidate list below must be rebuilt in exactly the order the hand labels in
 * test/fixtures/match/labels.mjs were written against — queries sorted by slug, then
 * Blinkit results in file order crossed with Zepto results in file order, keeping only
 * pairs that pass the quantity and brand gates, numbered from 1. If that order ever
 * drifts, every label points at a different pair and the numbers below are fiction, so
 * the expected totals are asserted up front.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brandKey, CONFIDENT_FLOOR, group, parseQty, qtyEq, THRESHOLD } from "../src/core/match.ts";
import { TRUE_IDS } from "../test/fixtures/match/labels.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH = join(ROOT, "test/fixtures/match/search");

const EXPECTED_CANDIDATES = 476;
const EXPECTED_POSITIVES = 138;
const MIN_PRECISION = 0.97;
const MIN_RECALL = 0.95;

// ---- corpus -------------------------------------------------------------

/** { [querySlug]: { [platform]: Product[] } }, each file named `<platform>__<slug>.json`. */
function loadCorpus() {
  const byQuery = {};
  for (const file of readdirSync(SEARCH).filter((f) => f.endsWith(".json"))) {
    const [platform, slug] = file.replace(/\.json$/, "").split("__");
    const raw = JSON.parse(readFileSync(join(SEARCH, file), "utf8"));
    if (!Array.isArray(raw)) continue;
    byQuery[slug] ??= {};
    byQuery[slug][platform] = raw.map((x) => ({
      platform,
      id: String(x.productId ?? x.id),
      name: x.name,
      brand: x.brand ?? null,
      unit: x.unit ?? null,
      price: x.price,
      mrp: x.mrp,
      discountPct: x.discountPct ?? 0,
      inStock: x.inStock,
    }));
  }
  return byQuery;
}

const corpus = loadCorpus();
const queries = Object.keys(corpus).sort();
const products = queries.reduce((n, q) => n + Object.values(corpus[q]).reduce((m, list) => m + list.length, 0), 0);

// ---- candidate list, in label order ------------------------------------

const candidates = [];
for (const q of queries) {
  const B = corpus[q].blinkit ?? [];
  const Z = corpus[q].zepto ?? [];
  for (const b of B) {
    for (const z of Z) {
      if (!qtyEq(parseQty(b.unit, b.name), parseQty(z.unit, z.name))) continue;
      const bk = brandKey(b.brand);
      const zk = brandKey(z.brand);
      if (bk && zk && bk !== zk) continue;
      candidates.push({ i: candidates.length + 1, q, b, z });
    }
  }
}
for (const c of candidates) c.label = TRUE_IDS.has(c.i);
const positives = candidates.filter((c) => c.label).length;

if (candidates.length !== EXPECTED_CANDIDATES || positives !== EXPECTED_POSITIVES) {
  console.error(
    `bench-match: candidate list drifted from the hand labels — got ${candidates.length} candidates / ` +
      `${positives} positives, expected ${EXPECTED_CANDIDATES} / ${EXPECTED_POSITIVES}.\n` +
      "Every label index now points at a different pair, so the labels are meaningless. " +
      "Fix the gates or the enumeration order before trusting any number from this script.",
  );
  process.exit(2);
}

// ---- predict, through the real public entry point ----------------------

/**
 * Run `group()` on each query exactly as the CLI would, and report which of the labelled
 * pairs it actually put together. Keys carry the query slug because the same two products
 * show up under more than one query and must be judged separately in each.
 */
function predict(threshold) {
  const merged = new Map();
  let groups = 0;
  let singletons = 0;
  for (const q of queries) {
    const items = [...(corpus[q].blinkit ?? []), ...(corpus[q].zepto ?? [])];
    const seen = new Set();
    for (const g of group(items, { threshold })) {
      groups++;
      if (g.offers.length === 1) singletons++;
      for (const a of g.offers) {
        for (const b of g.offers) if (a !== b) merged.set(`${q}|${a.platform}:${a.id}|${b.platform}:${b.id}`, g);
      }
      for (const a of g.offers) seen.add(`${a.platform}:${a.id}`);
    }
    const expected = new Set(items.map((x) => `${x.platform}:${x.id}`));
    if (seen.size !== expected.size) {
      console.error(`bench-match: group() lost or duplicated items for query ${q}`);
      process.exit(2);
    }
  }
  return { merged, groups, singletons };
}

function evaluate(threshold) {
  const { merged, groups, singletons } = predict(threshold);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let uncertainTp = 0;
  let uncertainFp = 0;
  const errors = [];
  for (const c of candidates) {
    const g = merged.get(`${c.q}|${c.b.platform}:${c.b.id}|${c.z.platform}:${c.z.id}`);
    if (g && c.label) {
      tp++;
      if (!g.confident) uncertainTp++;
    } else if (g && !c.label) {
      fp++;
      if (!g.confident) uncertainFp++;
      errors.push({ kind: "FP", c, confident: g.confident });
    } else if (!g && c.label) {
      fn++;
      errors.push({ kind: "FN", c, confident: null });
    } else {
      tn++;
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { threshold, precision, recall, f1, tp, fp, fn, tn, uncertainTp, uncertainFp, errors, groups, singletons };
}

const r = evaluate(THRESHOLD);
const pct = (x) => `${(100 * x).toFixed(1)}%`;

// ---- speed --------------------------------------------------------------

const biggest = queries
  .map((q) => [...(corpus[q].blinkit ?? []), ...(corpus[q].zepto ?? [])])
  .sort((a, b) => b.length - a.length)[0];
for (let i = 0; i < 50; i++) group(biggest); // warm up
const t0 = performance.now();
for (let i = 0; i < 200; i++) group(biggest);
const perCall = (performance.now() - t0) / 200;

// ---- report -------------------------------------------------------------

console.log(`corpus      ${products} products, ${queries.length} queries, 2 platforms`);
console.log(`candidates  ${candidates.length} gated pairs, ${positives} hand-labelled positives`);
console.log(`groups      ${r.groups} (${r.singletons} singletons)`);
console.log(`settings    threshold ${THRESHOLD}, confident floor ${CONFIDENT_FLOOR}\n`);
console.log(`precision   ${pct(r.precision)}   (${r.tp} correct of ${r.tp + r.fp} merged)`);
console.log(`recall      ${pct(r.recall)}   (${r.tp} found of ${positives} positives)`);
console.log(`F1          ${pct(r.f1)}`);
console.log(`counts      tp ${r.tp}  fp ${r.fp}  fn ${r.fn}  tn ${r.tn}`);
console.log(
  `uncertain   ${r.uncertainFp}/${r.fp} wrong merges and ${r.uncertainTp}/${r.tp} right ones marked confident:false`,
);
console.log(`speed       ${perCall.toFixed(2)} ms to group ${biggest.length} products\n`);

for (const { kind, c, confident } of r.errors) {
  const how = kind === "FP" ? (confident ? "merged, unmarked" : "merged, marked uncertain") : "not merged";
  console.log(`${kind} #${c.i} ${c.q} (${how})`);
  console.log(`   blinkit  ${c.b.name}  MRP ${c.b.mrp}`);
  console.log(`   zepto    ${c.z.name}  MRP ${c.z.mrp}`);
}
if (r.errors.length === 0) console.log("no errors");

// The neighbourhood, so the chosen threshold is auditable rather than asserted.
console.log("\nthreshold  prec   rec    F1     tp  fp  fn");
for (const t of [0.28, 0.32, 0.36, 0.4, 0.44, 0.48, 0.52]) {
  const e = evaluate(t);
  const mark = t === THRESHOLD ? " <-" : "";
  console.log(
    `  ${t.toFixed(2)}     ${pct(e.precision).padStart(6)} ${pct(e.recall).padStart(6)} ${pct(e.f1).padStart(6)}` +
      `  ${String(e.tp).padStart(3)} ${String(e.fp).padStart(3)} ${String(e.fn).padStart(3)}${mark}`,
  );
}

const failed = r.precision < MIN_PRECISION || r.recall < MIN_RECALL;
console.log(`\n${failed ? "FAIL" : "PASS"}  gate: precision >= ${pct(MIN_PRECISION)}, recall >= ${pct(MIN_RECALL)}`);
process.exit(failed ? 1 : 0);
