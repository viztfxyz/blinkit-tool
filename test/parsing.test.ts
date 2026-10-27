import { describe, expect, it } from "vitest";
import { parseCard, refine } from "../src/platforms/blinkit/parsing.js";
import type { BlinkitProduct } from "../src/platforms/blinkit/types.js";

const card = (over: Record<string, unknown> = {}, inventory = 5) => ({
  product_state: "available",
  is_sold_out: false,
  atc_action: {
    add_to_cart: {
      cart_item: {
        product_id: 211410,
        display_name: "Pears Soap",
        brand: "Pears",
        unit: "125 g",
        price: 50,
        mrp: 60,
        inventory,
      },
    },
  },
  ...over,
});

describe("parseCard stock", () => {
  it("is in stock when available with inventory", () => {
    expect(parseCard(card())?.inStock).toBe(true);
  });

  it("is sold out when listings mark product_state out_of_stock, even with is_sold_out false", () => {
    expect(parseCard(card({ product_state: "out_of_stock" }))?.inStock).toBe(false);
  });

  it("is sold out with zero inventory or is_sold_out", () => {
    expect(parseCard(card({}, 0))?.inStock).toBe(false);
    expect(parseCard(card({ is_sold_out: true }))?.inStock).toBe(false);
  });

  it("ignores snippets without a cart item", () => {
    expect(parseCard({ title: { text: "header" } })).toBeNull();
  });
});

describe("refine", () => {
  const p = (productId: number, price: number, inStock = true, related = false) =>
    ({
      productId,
      price,
      mrp: price,
      discountPct: 0,
      inStock,
      related,
      name: `p${productId}`,
      brand: null,
    }) as BlinkitProduct;

  it("drops sold-out items only when inStock is asked for", () => {
    const items = [p(1, 10), p(2, 20, false)];
    expect(refine(items, 10).map((x) => x.productId)).toEqual([1, 2]);
    expect(refine(items, 10, "relevance", { inStock: true }).map((x) => x.productId)).toEqual([1]);
  });

  it("sorts by price but keeps related padding last", () => {
    const items = [p(1, 30), p(2, 5, true, true), p(3, 10)];
    expect(refine(items, 10, "price").map((x) => x.productId)).toEqual([3, 1, 2]);
  });
});
