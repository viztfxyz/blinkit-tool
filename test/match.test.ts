import { describe, expect, it } from "vitest";
import type { MatchGroup, TaggedProduct } from "../src/core/match.js";
import {
  buildIdf,
  CONFIDENT_FLOOR,
  canonTokens,
  group,
  parseQty,
  prepare,
  qtyEq,
  score,
  THRESHOLD,
} from "../src/core/match.js";

let seq = 0;
const item = (over: Partial<TaggedProduct> & { name: string; platform: string }): TaggedProduct => ({
  id: `p${++seq}`,
  brand: null,
  unit: null,
  price: 20,
  mrp: 20,
  inStock: true,
  ...over,
});

/** The score a pair gets with the idf `group()` would build for that pair's query. */
const pairScore = (a: TaggedProduct, b: TaggedProduct, context: TaggedProduct[] = []) => {
  const prepared = [a, b, ...context].map(prepare);
  return score(prepared[0], prepared[1], buildIdf(prepared.map((p) => p.tokens)));
};

const titles = (groups: MatchGroup[]) => groups.map((g) => g.offers.map((o) => o.name));
const grouped = (groups: MatchGroup[], a: string, b: string) =>
  groups.some((g) => g.offers.some((o) => o.name === a) && g.offers.some((o) => o.name === b));

describe("parseQty", () => {
  it("reads the formats the real corpus uses", () => {
    expect(parseQty("500 ml")).toEqual({ value: 500, cls: "vol", packs: 1 });
    expect(parseQty("1 ltr")).toEqual({ value: 1000, cls: "vol", packs: 1 });
    expect(parseQty("1 pack (500 ml)")).toEqual({ value: 500, cls: "vol", packs: 1 });
    expect(parseQty("6 pcs")).toEqual({ value: 6, cls: "count", packs: 1 });
    expect(parseQty("1 pc")).toEqual({ value: 1, cls: "count", packs: 1 });
    expect(parseQty("2 x 500 ml")).toEqual({ value: 1000, cls: "vol", packs: 2 });
    expect(parseQty("1 pack (5 x 125 g)")).toEqual({ value: 625, cls: "mass", packs: 5 });
    expect(parseQty("pack of 6")).toEqual({ value: 6, cls: "count", packs: 6 });
  });

  it("reads a size glued into the name when there is no unit field", () => {
    expect(parseQty(null, "Fresh Tender Coconut Water,1 Pc")).toEqual({
      value: 1,
      cls: "count",
      packs: 1,
    });
    expect(parseQty(undefined, "Lay's Classic Salted Potato Chips - 52 g")).toEqual({
      value: 52,
      cls: "mass",
      packs: 1,
    });
  });

  it("prefers the unit field over a size mentioned in the name", () => {
    expect(parseQty("500 ml", "Amul Taaza Milk (also in 1 L)")?.value).toBe(500);
  });

  it("multiplies a per-unit size by an explicit pack count", () => {
    expect(parseQty("pack of 6", "Coca-Cola 300 ml")).toEqual({
      value: 1800,
      cls: "vol",
      packs: 6,
    });
  });

  it("skips words that look like units but are not", () => {
    // "1 pack" must not be read as one piece, or "1 pack (500 ml)" would be a count.
    expect(parseQty("1 pack (500 ml)")?.cls).toBe("vol");
  });

  it("returns null when there is no size anywhere", () => {
    expect(parseQty(null, "Dove Dandruff Care Shampoo")).toBeNull();
    expect(parseQty()).toBeNull();
  });

  it("treats litre, L and millilitre spellings as the same volume", () => {
    expect(qtyEq(parseQty("1 ltr"), parseQty("1 L"))).toBe(true);
    expect(qtyEq(parseQty("1 ltr"), parseQty("1000 ml"))).toBe(true);
    expect(qtyEq(parseQty("1 litre"), parseQty("1000 milliliter"))).toBe(true);
  });

  it("treats kg and g as the same mass", () => {
    expect(qtyEq(parseQty("1 kg"), parseQty("1000 g"))).toBe(true);
    expect(qtyEq(parseQty("1 kg"), parseQty("1000 gm"))).toBe(true);
  });

  it("never equates volume with mass or count", () => {
    expect(qtyEq(parseQty("1 L"), parseQty("1 kg"))).toBe(false);
    expect(qtyEq(parseQty("1000 ml"), parseQty("1000 g"))).toBe(false);
    expect(qtyEq(parseQty("6 pcs"), parseQty("6 g"))).toBe(false);
  });

  it("never equates a missing quantity with anything", () => {
    expect(qtyEq(null, parseQty("500 ml"))).toBe(false);
    expect(qtyEq(null, null)).toBe(false);
  });
});

describe("quantity gate", () => {
  // The dangerous failure: a 1 L carton at Rs 70 looks cheaper than a 500 ml pouch at Rs 40
  // only because the rows were merged. The gate is hard, so no score can override it.
  it("keeps 500 ml and 1 L apart even when everything else is identical", () => {
    const groups = group([
      item({ platform: "blinkit", name: "Amul Taaza Toned Milk", brand: "Amul", unit: "500 ml", price: 40, mrp: 40 }),
      item({ platform: "zepto", name: "Amul Taaza Toned Milk", brand: "Amul", unit: "1 L", price: 70, mrp: 40 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.offers.length === 1)).toBe(true);
  });

  it("groups the same size written two different ways", () => {
    const groups = group([
      item({
        platform: "blinkit",
        name: "Amul Gold Full Cream Milk",
        brand: "Amul",
        unit: "500 ml",
        price: 35,
        mrp: 35,
      }),
      item({
        platform: "zepto",
        name: "Amul Gold Full Cream Milk | Pouch",
        brand: "Amul",
        unit: "1 pack (500 ml)",
        price: 34,
        mrp: 35,
      }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("keeps products with an unparseable quantity to themselves", () => {
    const groups = group([
      item({ platform: "blinkit", name: "Dove Dandruff Care Shampoo", brand: "Dove", unit: null }),
      item({ platform: "zepto", name: "Dove Dandruff Care Shampoo", brand: "Dove", unit: null }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("brand gate", () => {
  it("never groups two known but different brands", () => {
    const groups = group([
      item({ platform: "blinkit", name: "Toned Milk Pouch", brand: "Amul", unit: "500 ml", mrp: 29 }),
      item({ platform: "zepto", name: "Toned Milk Pouch", brand: "Mother Dairy", unit: "500 ml", mrp: 29 }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("lets a missing brand through", () => {
    const groups = group([
      item({ platform: "blinkit", name: "Amul Masti Dahi Pouch", brand: "Amul", unit: "400 g", mrp: 45 }),
      item({ platform: "zepto", name: "Amul Masti Dahi Pouch", brand: null, unit: "400 g", mrp: 45 }),
    ]);
    expect(groups).toHaveLength(1);
  });
});

describe("canonTokens", () => {
  it("collapses Hindi-English names onto one spelling", () => {
    expect(canonTokens("Amul Masti Dahi Pouch", "Amul")).toEqual(canonTokens("Amul Masti Pouch Curd", "Amul"));
    expect(canonTokens("Tata Namak", "Tata")).toEqual(canonTokens("Tata Salt", "Tata"));
    expect(canonTokens("Tata Sampann Arhar Dal", "Tata Sampann")).toEqual(
      canonTokens("Tata Sampann Toor Dal", "Tata Sampann"),
    );
    expect(canonTokens("Organic Tattva Arhar Tur Dal", "Organic Tattva")).toContain("toor");
  });

  it("collapses British and American spellings", () => {
    expect(canonTokens("Tata Salt Iodised", "Tata")).toEqual(canonTokens("Tata Salt Iodized", "Tata"));
    expect(canonTokens("Amul Homogenised Milk", "Amul")).toEqual(canonTokens("Amul Homogenized Milk", "Amul"));
    expect(canonTokens("Amul Standardised Milk", "Amul")).toEqual(canonTokens("Amul Standardized Milk", "Amul"));
  });

  it("drops the brand, bracketed asides, sizes and packaging words", () => {
    expect(canonTokens("Amul Gold Milk (Tetra Pack) 500 ml Pouch", "Amul")).toEqual(["gold", "milk"]);
  });

  it("is order-insensitive and deduplicated", () => {
    expect(canonTokens("Dal Toor Toor", null)).toEqual(["dal", "toor"]);
  });
});

describe("score", () => {
  // Two names that share almost nothing but the same printed MRP. MRP is on the pack by
  // law and identical in every store, so it carries the pair.
  const amulGold = item({
    platform: "blinkit",
    name: "Amul Gold Milk",
    brand: "Amul",
    unit: "500 ml",
    price: 35,
    mrp: 83,
  });
  const amulGoldLong = item({
    platform: "zepto",
    name: "Amul Gold Homogenised Standardised Milk (Tetra Pack)",
    brand: "Amul",
    unit: "500 ml",
    price: 80,
    mrp: 83,
  });

  it("lifts a weak name pair over the line when the MRP is equal", () => {
    expect(pairScore(amulGold, amulGoldLong)).toBeGreaterThanOrEqual(THRESHOLD);
    expect(group([amulGold, amulGoldLong])).toHaveLength(1);
  });

  it("leaves the same weak name pair below the line when the MRP differs", () => {
    const different = { ...amulGoldLong, mrp: 90, price: 90 };
    expect(pairScore(amulGold, different)).toBeLessThan(THRESHOLD);
    expect(group([amulGold, different])).toHaveLength(2);
  });

  it("ignores an MRP of zero rather than treating two unknowns as equal", () => {
    const a = { ...amulGold, mrp: 0 };
    const b = { ...amulGoldLong, mrp: 0 };
    expect(pairScore(a, b)).toBeLessThan(pairScore(amulGold, amulGoldLong));
  });

  it("keeps distinct milk variants apart at the same size and MRP", () => {
    const taaza = item({ platform: "blinkit", name: "Amul Taaza Toned Milk", brand: "Amul", unit: "500 ml", mrp: 29 });
    const gold = item({ platform: "zepto", name: "Amul Gold Full Cream Milk", brand: "Amul", unit: "500 ml", mrp: 29 });
    expect(pairScore(taaza, gold)).toBeLessThan(THRESHOLD);
    expect(group([taaza, gold])).toHaveLength(2);
  });
});

describe("variant markers in a real query", () => {
  // One flavour per row on each platform, same size, same MRP: the only thing telling
  // Classic from Magic Masala is the variant words plus the 1:1 assignment that gives
  // each row its true partner.
  const flavours = ["Classic Salted", "India's Magic Masala", "American Style Cream & Onion", "Spanish Tomato Tango"];
  const chips = [
    ...flavours.map((f) =>
      item({ platform: "blinkit", name: `Lay's ${f} Potato Chips`, brand: "Lay's", unit: "52 g", price: 20, mrp: 20 }),
    ),
    ...flavours.map((f) =>
      item({
        platform: "zepto",
        name: `Lay's ${f} | Crunchy Potato Chips`,
        brand: "Lay's",
        unit: "52 g",
        price: 19,
        mrp: 20,
      }),
    ),
  ];
  const groups = group(chips);

  it("pairs every flavour with its own counterpart", () => {
    expect(groups).toHaveLength(4);
    for (const g of groups) expect(g.offers).toHaveLength(2);
  });

  it("never merges Classic Salted with India's Magic Masala", () => {
    expect(
      grouped(groups, "Lay's Classic Salted Potato Chips", "Lay's India's Magic Masala | Crunchy Potato Chips"),
    ).toBe(false);
    expect(
      grouped(groups, "Lay's India's Magic Masala Potato Chips", "Lay's Classic Salted | Crunchy Potato Chips"),
    ).toBe(false);
  });
});

describe("mutual-best 1:1 assignment", () => {
  const blinkit = item({
    platform: "blinkit",
    name: "Amul Masti Pouch Curd",
    brand: "Amul",
    unit: "400 g",
    price: 45,
    mrp: 45,
  });
  const zeptos = [
    item({ platform: "zepto", name: "Amul Masti Dahi Pouch", brand: "Amul", unit: "400 g", price: 43, mrp: 45 }),
    item({ platform: "zepto", name: "Amul Masti Dahi Cup", brand: "Amul", unit: "400 g", price: 44, mrp: 45 }),
    item({ platform: "zepto", name: "Amul Masti Spiced Dahi Pouch", brand: "Amul", unit: "400 g", price: 42, mrp: 45 }),
  ];

  it("lets one product claim at most one partner per platform", () => {
    const groups = group([blinkit, ...zeptos]);
    const merged = groups.filter((g) => g.offers.length > 1);
    expect(merged).toHaveLength(1);
    expect(merged[0].offers.map((o) => o.name)).toContain("Amul Masti Dahi Pouch");
    expect(groups.filter((g) => g.offers.length === 1)).toHaveLength(2);
  });

  it("gives the partner to the highest-scoring pair, not the first one seen", () => {
    const reversed = group([blinkit, ...[...zeptos].reverse()]);
    const merged = reversed.find((g) => g.offers.length > 1) as MatchGroup;
    expect(merged.offers.map((o) => o.name).sort()).toEqual(["Amul Masti Dahi Pouch", "Amul Masti Pouch Curd"].sort());
  });
});

describe("group", () => {
  const milk = [
    item({ platform: "blinkit", name: "Amul Taaza Toned Milk", brand: "Amul", unit: "500 ml", price: 28, mrp: 29 }),
    item({ platform: "blinkit", name: "Amul Gold Full Cream Milk", brand: "Amul", unit: "500 ml", price: 35, mrp: 35 }),
    item({
      platform: "blinkit",
      name: "Mother Dairy Toned Milk",
      brand: "Mother Dairy",
      unit: "500 ml",
      price: 28,
      mrp: 29,
    }),
    item({ platform: "blinkit", name: "Amul Taaza Toned Milk", brand: "Amul", unit: "1 L", price: 56, mrp: 58 }),
    item({
      platform: "zepto",
      name: "Amul Taaza Toned Fresh Milk | Pouch",
      brand: "Amul",
      unit: "1 pack (500 ml)",
      price: 27,
      mrp: 29,
    }),
    item({
      platform: "zepto",
      name: "Amul Gold Full Cream Fresh Milk | Pouch",
      brand: "Amul",
      unit: "1 pack (500 ml)",
      price: 34,
      mrp: 35,
    }),
    item({
      platform: "zepto",
      name: "Nandini Goodlife Toned Milk",
      brand: "Nandini",
      unit: "500 ml",
      price: 26,
      mrp: 27,
    }),
  ];

  it("returns every input item in exactly one group", () => {
    const groups = group(milk);
    const ids = groups.flatMap((g) => g.offers.map((o) => `${o.platform}:${o.id}`));
    expect(ids).toHaveLength(milk.length);
    expect(new Set(ids).size).toBe(milk.length);
    expect(new Set(ids)).toEqual(new Set(milk.map((m) => `${m.platform}:${m.id}`)));
  });

  it("leaves a product that matches nothing as a group of one", () => {
    const groups = group(milk);
    const lonely = groups.filter((g) => g.offers.length === 1).map((g) => g.offers[0].name);
    expect(lonely).toContain("Mother Dairy Toned Milk");
    expect(lonely).toContain("Nandini Goodlife Toned Milk");
    expect(titles(groups)).toEqual(expect.arrayContaining([["Mother Dairy Toned Milk"]]));
  });

  it("is deterministic and does not depend on which platform came first", () => {
    const once = group(milk);
    const twice = group(milk);
    expect(titles(twice)).toEqual(titles(once));
    const flipped = group([...milk].reverse());
    const key = (g: MatchGroup) =>
      g.offers
        .map((o) => o.id)
        .sort()
        .join("+");
    expect(flipped.map(key).sort()).toEqual(once.map(key).sort());
  });

  it("names the group with the shortest offer name and its cleanest unit", () => {
    const groups = group(milk);
    const taaza = groups.find((g) => g.offers.length === 2 && g.offers[0].mrp === 29) as MatchGroup;
    expect(taaza.title).toBe("Amul Taaza Toned Milk");
    expect(taaza.unit).toBe("500 ml");
  });

  it("sorts offers cheapest in-stock first, then out-of-stock", () => {
    const groups = group([
      item({ platform: "blinkit", name: "Tata Salt Iodised", brand: "Tata", unit: "1 kg", price: 30, mrp: 32 }),
      item({
        platform: "zepto",
        name: "Tata Namak Iodized",
        brand: "Tata",
        unit: "1 kg",
        price: 25,
        mrp: 32,
        inStock: false,
      }),
      item({ platform: "instamart", name: "Tata Salt Iodized", brand: "Tata", unit: "1 kg", price: 28, mrp: 32 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].offers.map((o) => [o.platform, o.price, o.inStock])).toEqual([
      ["instamart", 28, true],
      ["blinkit", 30, true],
      ["zepto", 25, false],
    ]);
  });

  it("holds at most one offer per platform in a group", () => {
    const groups = group(milk);
    for (const g of groups) {
      const platforms = g.offers.map((o) => o.platform);
      expect(new Set(platforms).size).toBe(platforms.length);
    }
  });

  it("handles an empty and a single-item input", () => {
    expect(group([])).toEqual([]);
    const one = group([item({ platform: "blinkit", name: "Amul Gold Milk", brand: "Amul", unit: "500 ml" })]);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ title: "Amul Gold Milk", unit: "500 ml", confident: true });
  });
});

describe("confidence", () => {
  // A real false positive from the corpus: same brand, same size, same MRP, and the only
  // difference is which hair problem the bottle claims to fix. It scores in the band just
  // above the threshold, so it is still shown as one group but flagged, never silently.
  const dryness = item({
    platform: "blinkit",
    name: "Dove Dryness Care Shampoo For Very Dry Hair",
    brand: "Dove",
    unit: "650 ml",
    price: 400,
    mrp: 435,
  });
  const dandruff = item({
    platform: "zepto",
    name: "Dove Dandruff Care Shampoo",
    brand: "Dove",
    unit: "650 ml",
    price: 410,
    mrp: 435,
  });

  it("marks a near-threshold merge instead of merging it silently", () => {
    const s = pairScore(dryness, dandruff);
    expect(s).toBeGreaterThanOrEqual(THRESHOLD);
    expect(s).toBeLessThan(CONFIDENT_FLOOR);
    const groups = group([dryness, dandruff]);
    expect(groups).toHaveLength(1);
    expect(groups[0].offers).toHaveLength(2);
    expect(groups[0].confident).toBe(false);
  });

  it("is confident about a strong merge", () => {
    const groups = group([
      item({ platform: "blinkit", name: "Amul Masti Pouch Curd", brand: "Amul", unit: "400 g", price: 45, mrp: 45 }),
      item({ platform: "zepto", name: "Amul Masti Dahi Pouch", brand: "Amul", unit: "400 g", price: 43, mrp: 45 }),
    ]);
    expect(groups[0].offers).toHaveLength(2);
    expect(groups[0].confident).toBe(true);
  });

  it("is confident about a group of one, which merged nothing", () => {
    const groups = group([
      item({ platform: "blinkit", name: "Red Bull Energy Drink", brand: "Red Bull", unit: "250 ml" }),
    ]);
    expect(groups[0].confident).toBe(true);
  });
});

describe("performance", () => {
  it("groups ~60 products well under 50 ms", () => {
    const names = [
      "Amul Taaza Toned Milk",
      "Amul Gold Full Cream Milk",
      "Amul Masti Dahi Pouch",
      "Amul Slim n Trim Milk",
      "Mother Dairy Toned Milk",
      "Mother Dairy Classic Dahi",
      "Nandini Goodlife Toned Milk",
      "Tata Salt Iodised",
      "Tata Sampann Toor Dal",
      "Tata Tea Premium",
      "Aashirvaad Shudh Chakki Atta",
      "Fortune Chakki Fresh Atta",
      "Pillsbury Chakki Fresh Atta",
      "Lay's Classic Salted Potato Chips",
      "Lay's India's Magic Masala Potato Chips",
      "Kurkure Masala Munch",
      "Haldiram Aloo Bhujia",
      "Parle-G Original Gluco Biscuits",
      "Britannia Whole Wheat Bread",
      "Sunfeast Dark Fantasy Choco Fills",
      "Maggi 2-Minute Masala Noodles",
      "Nescafe Classic Coffee",
      "Nestle Everyday Dairy Whitener",
      "Red Bull Energy Drink",
      "Coca-Cola Original Taste",
      "Sprite Lime Soft Drink",
      "Surf Excel Easy Wash Detergent",
      "Harpic Power Plus Toilet Cleaner",
      "Dettol Original Bathing Soap",
      "Pears Pure Gentle Soap",
    ];
    const products = names.flatMap((name, i) => [
      item({ platform: "blinkit", name, unit: "500 ml", price: 40 + i, mrp: 50 + i }),
      item({ platform: "zepto", name: `${name} | Pack`, unit: "1 pack (500 ml)", price: 38 + i, mrp: 50 + i }),
    ]);
    expect(products).toHaveLength(60);

    group(products); // warm up, so this measures the matcher and not the first-call JIT
    const started = performance.now();
    const groups = group(products);
    const elapsed = performance.now() - started;

    expect(groups.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });
});
