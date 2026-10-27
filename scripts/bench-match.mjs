#!/usr/bin/env node
/**
 * Benchmark src/core/match.ts against the captured corpus in test/fixtures/match/.
 *
 * Run with `npm run bench:match`. Needs a Node that strips TypeScript types on import
 * (>= 22.18); otherwise run it as `npx tsx scripts/bench-match.mjs`.
 *
 * corpus.json holds each query's search results per platform; labels.json lists, per
 * query, the hand-labelled true matches as ["blinkit:<id>", "zepto:<id>"] pairs. A pair
 * is judged within its query, since the same two products can show up under several.
 * test/match-bench.test.ts enforces the same gate in `npm test`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brandKey, CONFIDENT_FLOOR, group, parseQty, qtyEq, THRESHOLD } from "../src/core/match.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/match");

const MIN_PRECISION = 0.97;
const MIN_RECALL = 0.95;

// ---- corpus -------------------------------------------------------------

/** { [query]: { [platform]: TaggedProduct[] } } */
function loadCorpus() {
  const { fields, queries } = JSON.parse(readFileSync(join(FIXTURES, "corpus.json"), "utf8"));
  const byQuery = {};
  for (const [q, platforms] of Object.entries(queries)) {
    byQuery[q] = {};
    for (const [platform, rows] of Object.entries(platforms)) {
      byQuery[q][platform] = rows.map((row) => ({
        platform,
        ...Object.fromEntries(fields.map((f, i) => [f, row[i]])),
      }));
    }
  }
  return byQuery;
}

const corpus = loadCorpus();
const labels = JSON.parse(readFileSync(join(FIXTURES, "labels.json"), "utf8"));
const queries = Object.keys(corpus).sort();
const products = queries.reduce((n, q) => n + Object.values(corpus[q]).reduce((m, list) => m + list.length, 0), 0);

// ---- candidates: every pair that passes the quantity and brand gates ----

const pairKey = (q, b, z) => `${q}|${b.platform}:${b.id}|${z.platform}:${z.id}`;
const truth = new Set(Object.entries(labels).flatMap(([q, pairs]) => pairs.map(([b, z]) => `${q}|${b}|${z}`)));

const candidates = [];
for (const q of queries) {
  for (const b of corpus[q].blinkit ?? []) {
    for (const z of corpus[q].zepto ?? []) {
      if (!qtyEq(parseQty(b.unit, b.name), parseQty(z.unit, z.name))) continue;
      const bk = brandKey(b.brand);
      const zk = brandKey(z.brand);
      if (bk && zk && bk !== zk) continue;
      candidates.push({ q, b, z, label: truth.has(pairKey(q, b, z)) });
    }
  }
}
const positives = candidates.filter((c) => c.label).length;

if (positives !== truth.size) {
  console.error(
    `bench-match: ${truth.size - positives} labelled pair(s) are missing from the corpus or fail the gates; ` +
      "fix labels.json before trusting any number from this script.",
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
    const g = merged.get(pairKey(c.q, c.b, c.z));
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
  console.log(`${kind} ${c.q} (${how})`);
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
