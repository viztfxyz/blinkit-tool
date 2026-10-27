import { createInterface } from "node:readline/promises";
import { type Command, InvalidArgumentError, Option } from "commander";
import { AmazonNow } from "../amazon/client.js";
import { OTP_CHANNELS, type OtpChannel } from "../amazon/login.js";
import type { NowAddress, NowBill, NowCart, NowOrder, NowProduct } from "../amazon/types.js";
import { HANDOFFS, type Handoff } from "../pay/status.js";
import { json } from "./format.js";

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

let client: AmazonNow | undefined;
const now = () => (client ??= new AmazonNow());

function products(items: NowProduct[]): void {
  if (!items.length) {
    console.log("No products found.");
    return;
  }
  items.forEach((p, i) => {
    const price = p.discountPct ? `₹${p.price} (MRP ₹${p.mrp}, -${p.discountPct}%)` : `₹${p.price}`;
    const stock = p.inStock ? "" : "  [OUT OF STOCK]";
    console.log(`${String(i + 1).padStart(3)}. ${[p.name, p.unit, price].filter(Boolean).join(" · ")}${stock}`);
    console.log(`     asin=${p.asin}`);
  });
}

function cart(c: NowCart): void {
  if (!c.items.length) {
    console.log("Cart is empty.");
    return;
  }
  for (const i of c.items) {
    const flag = i.available ? "" : "  [UNAVAILABLE]";
    console.log(
      `  ${i.quantity} × ${[i.name, i.unit].filter(Boolean).join(" · ")}  ₹${i.lineTotal}  (${i.asin})${flag}`,
    );
  }
  const saved = c.itemsMrp > c.itemsTotal ? `  (MRP ₹${c.itemsMrp})` : "";
  console.log(`Items: ₹${c.itemsTotal}${saved}`);
}

function bill(b: NowBill): void {
  for (const l of b.lines) {
    const was = l.listAmount != null ? ` (was ₹${l.listAmount})` : "";
    console.log(`  ${l.label.padEnd(20)} ₹${l.amount}${was}`);
  }
  console.log(`  ${"To pay".padEnd(20)} ₹${b.total}`);
  if (b.address) console.log(`Deliver to: ${b.address}`);
  if (b.etaMinutes != null) console.log(`Arrives in about ${b.etaMinutes} min`);
  for (const issue of b.issues) console.log(`  ! ${issue}`);
  console.log(`Pay with: blinkit amazon pay --confirm ${b.total}`);
}

function orders(list: NowOrder[]): void {
  if (!list.length) {
    console.log("No active Amazon Now orders.");
    return;
  }
  for (const o of list) {
    const eta = o.etaMinutes ? ` · ${o.etaMinutes} min` : "";
    console.log(`${o.orderId}  ${o.status}${eta}${o.payment ? ` · payment ${o.payment}` : ""}`);
    for (const i of o.items) console.log(`  ${i.quantity} × ${i.name}`);
  }
}

function addresses(list: NowAddress[]): void {
  if (!list.length) {
    console.log("No saved addresses on this Amazon account.");
    return;
  }
  for (const a of list) {
    const mark = a.selected ? "*" : " ";
    const tags = [a.serviceable ? null : "not served by Amazon Now", a.isDefault ? "Amazon default" : null]
      .filter(Boolean)
      .join(", ");
    console.log(`${mark} [${a.label ?? "—"}] ${a.text}${tags ? `  (${tags})` : ""}`);
    console.log(`    id=${a.id}`);
  }
}

const printCart = (o: { json?: boolean }) => (c: NowCart) => (o.json ? json(c) : cart(c));

export function registerAmazon(program: Command): void {
  const amazon = program
    .command("amazon")
    .description("Amazon Now (amazon.in 10-minute delivery): search, cart, checkout and UPI QR pay");

  amazon
    .command("login <phone>")
    .description("log in with an OTP (runs Amazon's sign-in in headless Chromium)")
    .addOption(new Option("--via <channel>", "where Amazon sends the OTP").choices(OTP_CHANNELS).default("sms"))
    .action(async (phone, o) => {
      const r = await now().requestOtp(phone, o.via as OtpChannel);
      const via = { whatsapp: " by WhatsApp", sms: " by SMS", unknown: "" }[r.channel];
      console.log(`OTP sent${via} to ${r.to}.${r.note ? ` ${r.note}.` : ""}`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const code = await rl.question("Enter OTP: ");
          try {
            json(await now().verifyOtp(code));
            return;
          } catch (e) {
            if (!(e instanceof Error) || !/OTP rejected/.test(e.message)) throw e;
            console.log(e.message);
          }
        }
      } finally {
        rl.close();
        await now().cancelLogin(); // closes the sign-in browser if the OTP never succeeded
      }
    });

  amazon.command("logout").action(async () => json(await now().logout()));
  amazon
    .command("whoami")
    .description("login and delivery address")
    .action(async () => json(await now().whoami()));

  const address = amazon.command("address").description("saved Amazon addresses; * marks the one in use");
  address
    .command("list", { isDefault: true })
    .option("--json", "print JSON")
    .action(async (o) => {
      const list = await now().addresses();
      o.json ? json(list) : addresses(list);
    });
  address
    .command("use <which>")
    .description("deliver to a saved address: label, id, or part of the address")
    .action(async (which) => {
      const a = await now().useAddress(which);
      console.log(`Delivering to [${a.label ?? "—"}] ${a.text}`);
    });

  amazon
    .command("search <query>")
    .option("-n, --limit <n>", "number of results", int, 24)
    .option("--in-stock", "only in-stock items")
    .option("--json", "print JSON")
    .action(async (query, o) => {
      const items = await now().search(query, { limit: o.limit, inStock: !!o.inStock });
      o.json ? json(items) : products(items);
    });

  amazon
    .command("product <asin>")
    .option("--json", "print JSON")
    .action(async (asin, o) => {
      const p = await now().product(asin);
      o.json ? json(p) : products([p]);
    });

  const c = amazon.command("cart").description("Amazon Now cart");
  c.command("show", { isDefault: true })
    .option("--json", "print JSON")
    .action(async (o) => printCart(o)(await now().cart()));
  c.command("add <asin>")
    .option("-q, --qty <n>", "quantity to add", int, 1)
    .option("--json", "print JSON")
    .action(async (asin, o) => printCart(o)(await now().add(asin, o.qty)));
  c.command("set <asin> <qty>")
    .description("set an absolute quantity (0 removes)")
    .option("--json", "print JSON")
    .action(async (asin, qty, o) => printCart(o)(await now().setQuantity(asin, int(qty))));
  c.command("remove <asin>")
    .option("--json", "print JSON")
    .action(async (asin, o) => printCart(o)(await now().setQuantity(asin, 0)));
  c.command("clear")
    .option("--json", "print JSON")
    .action(async (o) => printCart(o)(await now().clear()));

  amazon
    .command("checkout")
    .description("the payable bill for your Amazon address (doesn't place the order)")
    .option("--json", "print JSON")
    .action(async (o) => {
      const b = await now().checkout();
      o.json ? json(b) : bill(b);
    });

  amazon
    .command("orders")
    .description("active Amazon Now orders and their payment state")
    .option("--json", "print JSON")
    .action(async (o) => {
      const list = await now().orders();
      o.json ? json(list) : orders(list);
    });

  amazon
    .command("pay")
    .description(
      "place the order and pay by UPI QR (Scan & Pay). Never uses Amazon Pay balance. Gives a qrbaton pay link, or just the QR with --handoff qr",
    )
    .requiredOption("--confirm <rupees>", "the exact amount to pay, as shown by `blinkit amazon checkout`", num)
    .addOption(
      new Option("--handoff <how>", "qrbaton: pay page link with the order summary; qr: just the UPI QR image")
        .choices(HANDOFFS)
        .default("qrbaton"),
    )
    .option("--agent <name>", "shown on the pay page as who prepared the order")
    .option("--timeout <sec>", "seconds to wait for payment", int, 600)
    .option("--dry-run", "stop on Amazon's payment page with Scan & Pay UPI selected, before placing the order")
    .option("--no-open", "don't open the link / QR locally; just print it (agent handoff)")
    .action(async (o) => {
      const r = await now().pay({
        confirmAmount: o.confirm,
        timeoutSec: o.timeout,
        dryRun: o.dryRun,
        handoff: o.handoff as Handoff,
        agent: o.agent,
        openPage: o.open,
      });
      const msg: Record<string, string> = {
        paid: "Payment done, order placed.",
        failed: "Payment failed.",
        timeout: "QR expired without payment; Amazon cancels the unpaid order.",
        dry_run_ok: "Dry run OK.",
      };
      console.log(msg[r.stage] ?? r.stage);
      if (r.error) console.log("error:", r.error);
    });
}
