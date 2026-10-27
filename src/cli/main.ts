import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import { Blinkit } from "../client.js";
import { SORTS, type Sort, VERSION } from "../core/config.js";
import { BlinkitError } from "../core/errors.js";
import { allOk, formatChecks, runDoctor } from "../doctor.js";
import { HANDOFFS, type Handoff, payWithUpi } from "../pay/index.js";
import type { SearchOptions } from "../services/catalog.js";
import { now, registerAmazon } from "./amazon.js";
import * as fmt from "./format.js";
import { closePrompts } from "./prompt.js";
import { registerSetup } from "./setup.js";

const int = (v: string) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new InvalidArgumentError("not a number");
  return n;
};
const num = (v: string) => {
  const n = Number(v);
  if (Number.isNaN(n)) throw new InvalidArgumentError("not a number");
  return n;
};

let client: Blinkit | undefined;
const bk = () => (client ??= new Blinkit());

const withLocation = (c: Command) =>
  c
    .option("-p, --pincode <pincode>", "6-digit pincode (default: session address/area)")
    .option("--lat <lat>", "latitude", num)
    .option("--lon <lon>", "longitude", num);

const withFilters = (c: Command) =>
  withLocation(c)
    .option("-n, --limit <n>", "number of results", int, 24)
    .addOption(new Option("-s, --sort <sort>", "sort order").choices(SORTS).default("relevance"))
    .option("--max-price <rupees>", "maximum price", num)
    .option("--min-price <rupees>", "minimum price", num)
    .option("--brand <brand>", "brand name contains")
    .option("--min-discount <pct>", "minimum discount %", int)
    .option("--in-stock", "only in-stock items")
    .option("-o, --out-of-stock", "also list sold-out items, after the in-stock ones (slower)")
    .option("--json", "print JSON");

const searchOpts = (o: Record<string, unknown>): SearchOptions => ({
  pincode: o.pincode as string | undefined,
  lat: o.lat as number | undefined,
  lon: o.lon as number | undefined,
  limit: o.limit as number,
  sort: o.sort as Sort,
  maxPrice: o.maxPrice as number | undefined,
  minPrice: o.minPrice as number | undefined,
  brand: o.brand as string | undefined,
  minDiscount: o.minDiscount as number | undefined,
  inStock: !!o.inStock,
  includeOutOfStock: !!o.outOfStock,
});

const program = new Command("blinkit")
  .description("Unofficial Blinkit client: discovery, account, cart and UPI checkout")
  .version(VERSION);

// ---------- discovery ----------

program
  .command("locate <pincode>")
  .description("resolve a pincode to Blinkit coordinates (does not change the session)")
  .action(async (pincode) => fmt.json(await bk().locate(pincode)));

withLocation(program.command("location [pincode]"))
  .description("set the delivery area without login (indicative prices)")
  .action(async (pincode, o) =>
    fmt.json(await bk().setLocation({ pincode: pincode ?? o.pincode, lat: o.lat, lon: o.lon })),
  );

withFilters(program.command("search <query>"))
  .description("search products")
  .option("--exact", "drop Blinkit's 'related products' (shown by default)")
  .action(async (query, o) => {
    const items = await bk().catalog.search(query, { ...searchOpts(o), includeRelated: !o.exact });
    o.json ? fmt.json(items) : fmt.products(items, !o.outOfStock && !o.inStock);
  });

program
  .command("categories [name]")
  .description("category tree, or one group/category's contents")
  .option("--json", "print JSON")
  .action(async (name, o) => {
    if (name) {
      const e = await bk().catalog.findCategory(name);
      o.json ? fmt.json(e) : fmt.categoryMatch(e);
    } else {
      const tree = await bk().catalog.categories();
      o.json ? fmt.json(tree) : fmt.categoryTree(tree);
    }
  });

withFilters(program.command("browse <category>"))
  .description("list products in a category or subcategory, e.g. Milk or 'Dairy, Bread & Eggs'")
  .action(async (category, o) => {
    const r = await bk().catalog.browse(category, searchOpts(o));
    o.json ? fmt.json(r) : fmt.browse(r);
  });

withLocation(program.command("product <id>"))
  .description("product details: price, stock, category, attributes")
  .option("--json", "print JSON")
  .action(async (id, o) => {
    const p = await bk().catalog.product(int(id), o);
    o.json ? fmt.json(p) : fmt.product(p);
  });

// ---------- account ----------

program
  .command("login <phone>")
  .description("log in with an SMS OTP")
  .option("--otp <code>", "OTP (otherwise prompted)")
  .option("--send-only", "only send the OTP; finish with `blinkit verify <code>`")
  .action(async (phone, o) => {
    const r = await bk().account.requestOtp(phone);
    console.log(r.message ?? "OTP sent.");
    if (o.sendOnly) return;
    let code = o.otp as string | undefined;
    if (!code) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      code = await rl.question("Enter OTP: ");
      rl.close();
    }
    fmt.json(await bk().account.verifyOtp(code));
  });

program
  .command("verify <code>")
  .description("finish login with the OTP from SMS")
  .action(async (code) => fmt.json(await bk().account.verifyOtp(code)));

program.command("logout").action(async () => fmt.json(await bk().account.logout()));
program
  .command("whoami")
  .description("session: login, address, pricing, cart")
  .action(() => fmt.json(bk().account.whoami()));

const address = program.command("address").description("saved delivery addresses");
address
  .command("list", { isDefault: true })
  .option("--json", "print JSON")
  .action(async (o) => {
    const list = await bk().account.addresses();
    o.json ? fmt.json(list) : fmt.addresses(list, bk().state.address?.id);
  });
address
  .command("use <which>")
  .description("deliver to a saved address: label, id, or part of the text")
  .action(async (which) => {
    const r = await bk().account.useAddress(which);
    console.log(`Delivering to [${r.address.label}] ${r.address.text}`);
    if (r.cart) fmt.cart(r.cart);
  });
withLocation(address.command("add"))
  .description("save a new address")
  .requiredOption("--label <label>", "Home / Work / Other")
  .requiredOption("--name <name>", "receiver's name")
  .requiredOption("--line1 <text>", "flat / house / floor")
  .option("--line2 <text>", "street / area")
  .option("--landmark <text>")
  .action(async (o) => fmt.json(await bk().account.addAddress(o)));
address.command("delete <id>").action(async (id) => fmt.json(await bk().account.deleteAddress(int(id))));

// ---------- cart & checkout ----------

const printCart = (o: { json?: boolean }) => (c: Parameters<typeof fmt.cart>[0]) =>
  o.json ? fmt.json(c) : fmt.cart(c);
const cart = program.command("cart").description("server-priced cart");
cart
  .command("show", { isDefault: true })
  .option("--json", "print JSON")
  .action(async (o) => printCart(o)(await bk().cart.get()));
cart
  .command("add <productId>")
  .option("-q, --qty <n>", "quantity to add", int, 1)
  .option("--json", "print JSON")
  .action(async (id, o) => printCart(o)(await bk().cart.add(int(id), o.qty)));
cart
  .command("set <productId> <qty>")
  .description("set an absolute quantity (0 removes)")
  .option("--json", "print JSON")
  .action(async (id, qty, o) => printCart(o)(await bk().cart.set({ [int(id)]: int(qty) })));
cart
  .command("remove <productId>")
  .option("--json", "print JSON")
  .action(async (id, o) => printCart(o)(await bk().cart.remove(int(id))));
cart
  .command("clear")
  .option("--json", "print JSON")
  .action(async (o) => printCart(o)(await bk().cart.clear()));

program
  .command("checkout")
  .description("validate the cart for your address and show the payable bill")
  .option("--json", "print JSON")
  .action(async (o) => printCart(o)(await bk().cart.checkout()));

program
  .command("pay")
  .description("pay by UPI: places the order and gives you a qrbaton pay link (or just the QR with --handoff qr)")
  .requiredOption("--confirm <rupees>", "the exact amount to pay, as shown by `checkout`", num)
  .addOption(
    new Option("--handoff <how>", "qrbaton: pay page link with the order summary; qr: just the UPI QR image")
      .choices(HANDOFFS)
      .default("qrbaton"),
  )
  .option("--agent <name>", "shown on the pay page as who prepared the order")
  .option("--timeout <sec>", "seconds to wait for payment", int, 600)
  .option("--dry-run", "prepare the payment but don't generate a QR")
  .option("--browser", "drive blinkit.com in Chromium instead of the HTTP API")
  .option("--no-open", "don't open the link / QR locally; just print it (agent handoff)")
  .action(async (o) => {
    const r = await payWithUpi(bk(), {
      confirmAmount: o.confirm,
      timeoutSec: o.timeout,
      dryRun: o.dryRun,
      browser: o.browser,
      handoff: o.handoff as Handoff,
      agent: o.agent,
      openPage: o.open,
    });
    const msg: Record<string, string> = {
      paid: "Payment done, order placed.",
      failed: "Payment failed.",
      timeout: "Timed out waiting for payment.",
      browser_closed: "Browser closed before payment.",
      dry_run_ok: "Dry run OK.",
      qr_ready: "UPI QR ready.",
    };
    console.log(msg[r.stage] ?? r.stage);
    if (r.error) console.log("error:", r.error);
  });

// ---------- Amazon Now ----------

registerAmazon(program);

// ---------- setup ----------

registerSetup(program, bk, now);

program
  .command("doctor")
  .description("check Node, build, browser, logins and address; prints the fix for anything that's wrong")
  .option("--json", "print JSON")
  .action(async (o) => {
    const checks = await runDoctor({ bk: bk(), now: now() });
    o.json ? fmt.json(checks) : console.log(formatChecks(checks));
    if (!allOk(checks)) process.exitCode = 1;
  });

program
  .command("mcp")
  .description("run as an MCP stdio server")
  .action(async () => {
    const { runMcp } = await import("../mcp/server.js");
    await runMcp();
  });

export async function run(argv = process.argv): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (!(e instanceof BlinkitError)) throw e;
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  } finally {
    closePrompts();
  }
}
