import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Blinkit } from "../client.js";
import { SORTS, VERSION } from "../core/config.js";
import { BlinkitError } from "../core/errors.js";
import { HANDOFFS, type Handoff, readPayStatus, writePayStatus } from "../pay/index.js";
import type { SearchOptions } from "../services/catalog.js";

const INSTRUCTIONS = `Unofficial Blinkit tools.
Flow: blinkit_session → (optional) blinkit_login_request_otp + blinkit_login_verify_otp → blinkit_addresses →
blinkit_use_address → blinkit_search or blinkit_categories/blinkit_browse → blinkit_cart_set → blinkit_checkout →
(user confirms the amount) blinkit_pay → blinkit_pay_status → send the payLink (or, with handoff "qr", the QR image).
Search hides sold-out products; if the user asks about one that's missing, retry with includeOutOfStock=true.
Without login, call blinkit_set_location with a pincode to browse and build a cart at indicative prices.
Never request an OTP for a number the user didn't give you; ask the user for the code from their SMS.
Never call blinkit_pay without the user explicitly agreeing to the exact amount from blinkit_checkout.`;

const where = {
  pincode: z.string().optional().describe("6-digit pincode; defaults to the session's address/area"),
  lat: z.number().optional(),
  lon: z.number().optional(),
};
const filters = {
  limit: z.number().int().min(1).max(100).default(12),
  sort: z.enum(SORTS).default("relevance").describe("relevance | price (low→high) | price_desc | discount"),
  maxPrice: z.number().optional().describe("₹"),
  minPrice: z.number().optional().describe("₹"),
  brand: z.string().optional().describe("brand name contains"),
  minDiscount: z.number().int().optional().describe("minimum discount %"),
  inStock: z.boolean().default(false),
  includeOutOfStock: z
    .boolean()
    .default(false)
    .describe(
      "Also list sold-out products (inStock=false) after the in-stock ones. Blinkit's search hides them; slower.",
    ),
};

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

/** Wrap a handler so BlinkitErrors come back as tool errors the agent can read. */
const tool =
  <A>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      const text = e instanceof BlinkitError ? e.message : `unexpected error: ${(e as Error).message}`;
      return { content: [{ type: "text" as const, text }], isError: true };
    }
  };

export function createServer(bk = new Blinkit()): McpServer {
  const server = new McpServer({ name: "blinkit", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "blinkit_session",
    {
      description:
        "Current session: login, delivery address/area, pricing tier (indicative|payable), cart. Start here.",
    },
    tool(() => bk.account.whoami()),
  );
  server.registerTool(
    "blinkit_locate",
    {
      description:
        "Resolve an Indian 6-digit pincode to Blinkit coordinates and serviceability (does not change the session).",
      inputSchema: { pincode: z.string() },
    },
    tool(({ pincode }: { pincode: string }) => bk.locate(pincode)),
  );
  server.registerTool(
    "blinkit_set_location",
    {
      description:
        "Set the delivery area for search and cart without login (indicative prices). Clears any selected saved address.",
      inputSchema: where,
    },
    tool((a: { pincode?: string; lat?: number; lon?: number }) => bk.setLocation(a)),
  );
  server.registerTool(
    "blinkit_search",
    {
      description:
        "Search products deliverable at the session location (or a pincode). Returns productId, name, brand, unit, price, mrp, discountPct, inStock, url, related. related=true marks Blinkit's 'related products' (not direct matches); they sort after direct matches. Use productId with blinkit_cart_set.",
      inputSchema: { query: z.string(), ...where, ...filters, includeRelated: z.boolean().default(true) },
    },
    tool(({ query, ...o }: { query: string } & SearchOptions) => bk.catalog.search(query, o)),
  );
  server.registerTool(
    "blinkit_categories",
    {
      description:
        "Browse the app's category tree. No argument: all groups and categories with subcategory names. With a group name: its categories. With a category name/id: its subcategories.",
      inputSchema: { category: z.string().optional() },
    },
    tool(async ({ category }: { category?: string }) => {
      if (category) return bk.catalog.findCategory(category);
      return (await bk.catalog.categories()).map((g) => ({
        group: g.group,
        categories: g.categories.map((c) => ({
          id: c.id,
          name: c.name,
          subcategories: c.subcategories.map((s) => s.name),
        })),
      }));
    }),
  );
  server.registerTool(
    "blinkit_browse",
    {
      description:
        "List products in a subcategory (e.g. 'Milk', 'Chips & Wafers') or a whole category (e.g. 'Dairy, Bread & Eggs'), by name or id from blinkit_categories. Same sort/filters as search.",
      inputSchema: { category: z.string(), ...where, ...filters },
    },
    tool(({ category, ...o }: { category: string } & SearchOptions) => bk.catalog.browse(category, o)),
  );
  server.registerTool(
    "blinkit_product",
    {
      description:
        "Full product details: price, stock, category breadcrumbs, attributes (nutrition, shelf life, seller…).",
      inputSchema: { productId: z.number().int(), ...where },
    },
    tool(({ productId, ...w }: { productId: number }) => bk.catalog.product(productId, w)),
  );
  server.registerTool(
    "blinkit_login_request_otp",
    {
      description: "Send a login OTP by SMS to the user's own 10-digit mobile number, then ask the user for the code.",
      inputSchema: { phone: z.string() },
    },
    tool(({ phone }: { phone: string }) => bk.account.requestOtp(phone)),
  );
  server.registerTool(
    "blinkit_login_verify_otp",
    { description: "Complete login with the OTP the user read from their SMS.", inputSchema: { code: z.string() } },
    tool(({ code }: { code: string }) => bk.account.verifyOtp(code)),
  );
  server.registerTool(
    "blinkit_logout",
    { description: "Log out and forget the session token, address and cart." },
    tool(() => bk.account.logout()),
  );
  server.registerTool(
    "blinkit_addresses",
    { description: "List saved delivery addresses (id, label, text). Requires login." },
    tool(() => bk.account.addresses()),
  );
  server.registerTool(
    "blinkit_use_address",
    {
      description:
        "Deliver to a saved address, by label (e.g. 'Home'), id, or part of its text. Reprices the cart for that store.",
      inputSchema: { address: z.string() },
    },
    tool(({ address }: { address: string }) => bk.account.useAddress(address)),
  );
  server.registerTool(
    "blinkit_add_address",
    {
      description:
        "Save a new delivery address (requires login). line1 = flat/house, line2 = street/area. Location from lat/lon if given, else the pincode centre.",
      inputSchema: {
        label: z.string(),
        name: z.string(),
        line1: z.string(),
        line2: z.string().optional(),
        landmark: z.string().optional(),
        ...where,
      },
    },
    tool((a: { label: string; name: string; line1: string }) => bk.account.addAddress(a)),
  );
  server.registerTool(
    "blinkit_delete_address",
    {
      description: "Delete a saved address by id. Requires login. Confirm with the user first.",
      inputSchema: { addressId: z.number().int() },
    },
    tool(({ addressId }: { addressId: number }) => bk.account.deleteAddress(addressId)),
  );
  server.registerTool(
    "blinkit_cart",
    {
      description: "Price the cart with the server: items, quantities, bill (toPay, delivery, charges), delivery slot.",
    },
    tool(() => bk.cart.get()),
  );
  server.registerTool(
    "blinkit_cart_set",
    {
      description:
        'Set absolute quantities: {"<productId>": qty}; qty 0 removes. Returns per-line outcomes (applied | partially_available | unavailable | removed) and the priced cart.',
      inputSchema: { lines: z.record(z.string(), z.number().int().min(0)) },
    },
    tool(({ lines }: { lines: Record<string, number> }) => bk.cart.set(lines)),
  );
  server.registerTool(
    "blinkit_cart_add",
    {
      description: "Add quantity of a product on top of what's in the cart.",
      inputSchema: { productId: z.number().int(), quantity: z.number().int().min(1).default(1) },
    },
    tool(({ productId, quantity }: { productId: number; quantity: number }) => bk.cart.add(productId, quantity)),
  );
  server.registerTool(
    "blinkit_cart_clear",
    { description: "Empty the cart." },
    tool(() => bk.cart.clear()),
  );
  server.registerTool(
    "blinkit_checkout",
    {
      description:
        "Validate the cart for the selected saved address and return the payable bill. Does not place the order. Show the bill to the user before blinkit_pay.",
    },
    tool(() => bk.cart.checkout()),
  );
  server.registerTool(
    "blinkit_pay",
    {
      description:
        'Pay by UPI (headless). Only call after the user explicitly agrees to the exact amount from blinkit_checkout; pass it as confirmAmount. Starts the payment in the background; poll blinkit_pay_status until qr_ready. handoff "qrbaton" (default) gives a payLink: a page where the payer reviews the items and bill, taps Pay and approves in their UPI app, updated live when the payment completes. handoff "qr" gives just the UPI QR image to send.',
      inputSchema: {
        confirmAmount: z.number(),
        handoff: z
          .enum(HANDOFFS)
          .default("qrbaton")
          .describe("qrbaton: pay page link (default). qr: just the UPI QR image."),
        agent: z.string().max(60).optional().describe("Your name, shown on the pay page as who prepared the order"),
        openPage: z.boolean().optional().describe("Also open the link / QR on this machine (default false for agents)"),
      },
    },
    tool(
      async ({
        confirmAmount,
        handoff,
        agent,
        openPage,
      }: {
        confirmAmount: number;
        handoff: Handoff;
        agent?: string;
        openPage?: boolean;
      }) => {
        const toPay = (await bk.cart.checkout()).bill.toPay;
        if (Math.round(confirmAmount * 100) !== Math.round(toPay * 100)) {
          throw new BlinkitError(
            `amount to pay is ₹${toPay}, not ₹${confirmAmount}; confirm the new amount with the user`,
          );
        }
        writePayStatus({ stage: "starting", amount: toPay, handoff });
        const bin = import.meta.url.endsWith(".ts") ? "../bin/blinkit.ts" : "../bin/blinkit.js";
        const args = [
          fileURLToPath(new URL(bin, import.meta.url)),
          "pay",
          "--confirm",
          String(toPay),
          "--handoff",
          handoff,
        ];
        if (agent) args.push("--agent", agent);
        if (!openPage) args.push("--no-open");
        const child = spawn(process.execPath, [...process.execArgv, ...args], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, BLINKIT_SESSION: bk.sessionFile },
        });
        child.unref();
        return {
          started: true,
          amount: toPay,
          next: `poll blinkit_pay_status until qr_ready, then send the user ${handoff === "qr" ? "the QR image" : "payLink"}`,
        };
      },
    ),
  );
  server.registerTool(
    "blinkit_pay_status",
    {
      description:
        "Status of the last blinkit_pay. Stages: starting | launching | qr_ready | paid | failed | timeout | browser_closed | error. On qr_ready: payLink (send it to the user) when handoff is qrbaton; otherwise the UPI QR is attached as an image (send that). warning: qrbaton was unavailable, so only the QR is available. apiError: why the headless API fell back to the browser.",
    },
    async () => {
      const s = readPayStatus();
      const result = ok(s);
      if (s.stage === "qr_ready" && !s.payLink && s.qrImage) {
        try {
          const data = readFileSync(s.qrImage).toString("base64");
          return { content: [...result.content, { type: "image" as const, data, mimeType: "image/png" }] };
        } catch {}
      }
      return result;
    },
  );
  return server;
}

export async function runMcp(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
