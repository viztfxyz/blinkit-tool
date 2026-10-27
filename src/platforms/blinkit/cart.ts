import { HandcartError } from "../../core/errors.js";
import { parseCart } from "./parsing.js";
import type { Core } from "./session.js";
import type { BlinkitCart, Json, LineOutcome, Pricing } from "./types.js";

/**
 * The cart lives on Blinkit's server (priced per store). We keep productId → quantity locally,
 * send the whole list on each change, and adopt the server's quantities (it caps at stock limits).
 */
export class CartService {
  constructor(private core: Core) {}

  get pricing(): Pricing {
    return this.core.loggedIn && this.core.state.address ? "payable" : "indicative";
  }

  private async sync(): Promise<BlinkitCart> {
    const { state } = this.core;
    if (!this.core.currentLocation()) {
      throw new HandcartError(
        "set a delivery location first (`handcart blinkit location <pincode>` or `handcart blinkit address use <label>`)",
      );
    }
    const body: Json = {
      items: Object.entries(state.cart)
        .filter(([, q]) => q > 0)
        .map(([product_id, quantity]) => ({ product_id, quantity })),
    };
    if (state.address) body.address_id = state.address.id;
    const cid = this.core.loggedIn ? state.cartId : undefined;
    const data = cid
      ? await this.core.req("PUT", `/v5/carts/${cid}`, { json: body })
      : await this.core.req("POST", "/v5/carts", { json: body });
    const cd = data.cart_data ?? {};
    if (this.core.loggedIn && cd.id) state.cartId = cd.id;
    state.cart = Object.fromEntries(
      (cd.items ?? []).filter((i: Json) => i.quantity).map((i: Json) => [String(i.product_id), i.quantity]),
    );
    this.core.save();
    return parseCart(data, this.pricing);
  }

  /** Price the current cart with the server. */
  get(): Promise<BlinkitCart> {
    return this.sync();
  }

  /** Set absolute quantities ({productId: qty}); 0 removes. Reports a per-line outcome. */
  async set(lines: Record<string | number, number>): Promise<BlinkitCart> {
    const wanted = Object.entries(lines).map(([k, v]) => {
      const id = Number(k);
      if (!Number.isInteger(id) || id <= 0) throw new HandcartError(`'${k}' is not a product id`);
      if (!Number.isFinite(v)) throw new HandcartError(`quantity for ${k} must be a number`);
      return [String(id), Math.max(0, Math.trunc(v))] as const;
    });
    for (const [pid, q] of wanted) {
      if (q) this.core.state.cart[pid] = q;
      else delete this.core.state.cart[pid];
    }
    const result = await this.sync();
    const got = new Map(result.items.map((i) => [String(i.productId), i]));
    result.outcomes = wanted.map(([pid, q]): LineOutcome => {
      const productId = Number(pid);
      const item = got.get(pid);
      if (q === 0) return { productId, outcome: item ? "not_removed" : "removed" };
      if (!item) return { productId, outcome: "unavailable" };
      if (item.quantity < q) return { productId, outcome: "partially_available", granted: item.quantity };
      return { productId, outcome: "applied", quantity: item.quantity };
    });
    return result;
  }

  /** Add on top of the current quantity. */
  add(productId: number, quantity = 1): Promise<BlinkitCart> {
    return this.set({ [productId]: (this.core.state.cart[String(productId)] ?? 0) + quantity });
  }

  remove(productId: number): Promise<BlinkitCart> {
    return this.set({ [productId]: 0 });
  }

  clear(): Promise<BlinkitCart> {
    this.core.state.cart = {};
    return this.sync();
  }

  /**
   * Validate the cart for the selected saved address and return the payable bill.
   * Does not place an order; `payWithUpi` does that via Zomato zpaykit (UPI QR).
   */
  async checkout(): Promise<BlinkitCart> {
    const { state } = this.core;
    if (!this.core.loggedIn) throw new HandcartError("checkout needs login (`handcart blinkit login <phone>`)");
    if (!state.address) {
      throw new HandcartError(
        "choose a saved delivery address first (`handcart blinkit address list`, then `handcart blinkit address use`)",
      );
    }
    const cart = await this.sync();
    if (!cart.items.length) throw new HandcartError("cart is empty");
    const cid = state.cartId;
    if (!cid) throw new HandcartError("server did not assign a cart id; try `handcart blinkit cart` again");
    const data = await this.core.req("POST", `/v5/carts/${cid}/validate`, {
      json: {
        channel_address_id: state.address.id,
        items: cart.items.map((i) => ({ product_id: String(i.productId), quantity: i.quantity })),
        promo_codes: [null],
      },
    });
    const out = data.cart_data ? parseCart(data, "payable") : cart;
    out.checkout = {
      cartId: cid,
      state: data.cart_state ?? null,
      nextStep: `To pay by UPI: \`handcart blinkit pay --confirm ${out.bill.toPay}\``,
    };
    return out;
  }
}
