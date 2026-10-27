import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { group, type TaggedProduct } from "../src/core/match.js";

// The same gate as `npm run bench:match`, so `npm test` holds the README's numbers.
const FIXTURES = join(import.meta.dirname, "fixtures/match");
const read = (file: string) => JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));

const { fields, queries } = read("corpus.json") as {
  fields: (keyof TaggedProduct)[];
  queries: Record<string, Record<string, unknown[][]>>;
};
const labels = read("labels.json") as Record<string, [string, string][]>;

describe("match corpus", () => {
  it("groups the labelled pairs at >= 97% precision and >= 95% recall", () => {
    const truth = new Set(Object.entries(labels).flatMap(([q, pairs]) => pairs.map(([b, z]) => `${q}|${b}|${z}`)));
    const merged = new Set<string>();
    for (const [q, platforms] of Object.entries(queries)) {
      const items = Object.entries(platforms).flatMap(([platform, rows]) =>
        rows.map((row) => ({ platform, ...Object.fromEntries(fields.map((f, i) => [f, row[i]])) }) as TaggedProduct),
      );
      for (const g of group(items)) {
        for (const b of g.offers.filter((o) => o.platform === "blinkit")) {
          for (const z of g.offers.filter((o) => o.platform === "zepto"))
            merged.add(`${q}|blinkit:${b.id}|zepto:${z.id}`);
        }
      }
    }
    const tp = [...merged].filter((k) => truth.has(k)).length;
    const precision = tp / merged.size;
    const recall = tp / truth.size;
    expect(precision).toBeGreaterThanOrEqual(0.97);
    expect(recall).toBeGreaterThanOrEqual(0.95);
  });
});
