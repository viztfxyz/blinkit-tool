import { Core } from "./core/session.js";
import { Account } from "./services/account.js";
import { CartService } from "./services/cart.js";
import { Catalog } from "./services/catalog.js";

/**
 * Unofficial Blinkit client. Login, delivery address and cart persist to the session file
 * (`~/.config/blinkit-tool/session.json`, or `$BLINKIT_SESSION`).
 *
 * ```ts
 * const bk = new Blinkit();
 * await bk.setLocation({ pincode: "560034" });
 * const milk = await bk.catalog.search("milk", { sort: "price", inStock: true });
 * await bk.cart.add(milk[0].productId, 2);
 * ```
 */
export class Blinkit extends Core {
  readonly cart = new CartService(this);
  readonly catalog = new Catalog(this);
  readonly account = new Account(this, this.cart);
}
