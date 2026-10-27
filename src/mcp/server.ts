/**
 * The MCP stdio server. Every platform's tools are generated from the registry as `<platform>_<verb>`,
 * alongside the handcart-level fan-out tools, so a new store needs no edit here.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { allOk, formatChecks, runDoctor } from "../cli/doctor.js";
import { VERSION } from "../core/config.js";
import { HandcartError } from "../core/errors.js";
import type { Order, Product, SearchOptions, Tagged } from "../core/types.js";
import { SORTS } from "../core/types.js";
import { HANDOFFS, type Handoff, type PayStatus } from "../pay/index.js";
import {
  can,
  client,
  fanOut,
  type Platform,
  type PlatformDescriptor,
  platforms,
  reasonOf,
} from "../platforms/registry.js";
import { ok, tool } from "./tools.js";

const PLATFORMS = platforms();
const NAMES = PLATFORMS.map((d) => d.name).join(", ");

const INSTRUCTIONS = `Handcart: unofficial quick-commerce tools for ${NAMES}.
Call doctor first: it says, per platform, whether it is logged in and has a delivery address, and gives the
exact command to fix anything missing. Then the usual flow:
search (every platform at once) → <platform>_cart_add / <platform>_cart_set → <platform>_checkout →
(user confirms the amount) → <platform>_pay → <platform>_pay_status → send the payLink (or, with
handoff "qr", the QR image).
Fan-out tools (search, cart, orders, whoami, doctor, platforms) cover all platforms and never fail
wholesale: they return what answered plus an "errors" array of {platform, reason, fix}. Mention the fix
rather than retrying blindly. search returns results tagged with their platform and UNGROUPED: compare
rows yourself and keep each product's own id, because an id only means something on its own platform.
Every write (cart, checkout, pay) names one platform and takes that platform's own product id.
Search hides sold-out products; if the user asks about one that's missing, retry with includeOutOfStock=true.
Without login, <platform>_set_location with a pincode is enough to browse and build a cart at indicative prices.
Never request an OTP for a number the user didn't give you; ask the user for the code from their SMS.
Never call <platform>_pay without the user explicitly agreeing to the exact amount from <platform>_checkout.`;

const where = {
  pincode: z.string().optional().describe("6-digit pincode; defaults to the platform's address/area"),
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
    .describe("Also list sold-out products (inStock=false) after the in-stock ones. Stores hide them; slower."),
};

/** Newest first; an order with no date keeps its platform's order behind the dated ones. */
const byNewest = (a: Order, b: Order) => (Date.parse(b.placedAt ?? "") || 0) - (Date.parse(a.placedAt ?? "") || 0);

const tag = <T>(results: { platform: string; value: T[] }[]): Tagged<T>[] =>
  results.flatMap(({ platform, value }) => value.map((item) => ({ ...item, platform })));

/** The CLI entry the detached `pay` child runs; .ts under tsx, .js from dist. */
const payBin = () =>
  fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../bin/handcart.ts" : "../bin/handcart.js", import.meta.url),
  );

function registerFanOutTools(server: McpServer): void {
  server.registerTool(
    "search",
    {
      description: `Search every platform (${NAMES}) at once. Returns products tagged with their platform, UNGROUPED, plus an errors array. Each product's id is only valid on its own platform: pass it to that platform's cart tools.`,
      inputSchema: { query: z.string(), ...where, ...filters, includeRelated: z.boolean().default(true) },
    },
    tool(async ({ query, ...opts }: { query: string } & SearchOptions) => {
      const { results, errors } = await fanOut("search", (p) => p.search(query, opts));
      return { query, results: tag<Product>(results), errors };
    }),
  );
  server.registerTool(
    "cart",
    { description: "Every platform's open cart, server-priced, plus an errors array." },
    tool(async () => {
      const { results, errors } = await fanOut("cart", (p) => p.cart());
      return { carts: results, errors };
    }),
  );
  server.registerTool(
    "orders",
    { description: "Recent orders from every platform, merged newest first, plus an errors array." },
    tool(async () => {
      const { results, errors } = await fanOut("orders", async (p) => (await p.orders?.()) ?? []);
      return { orders: tag<Order>(results).sort(byNewest), errors };
    }),
  );
  server.registerTool(
    "whoami",
    { description: "Per platform: logged in, and where it delivers. Plus an errors array." },
    tool(async () => {
      // Keyed on `login` because "is this platform usable" only means something where you log in.
      const { results, errors } = await fanOut("login", (p) => p.whoami());
      return { sessions: results, errors };
    }),
  );
  server.registerTool(
    "doctor",
    {
      description:
        "Check everything needed to shop and pay: the browser, and each platform's login and delivery address. Start here. `report` has one ✓/✗ line per check, with the command that fixes a ✗.",
    },
    tool(async () => {
      const checks = await runDoctor();
      return { ok: allOk(checks), report: formatChecks(checks), checks };
    }),
  );
  server.registerTool(
    "platforms",
    { description: "Supported platforms, their state, and which capabilities each one has." },
    tool(async () =>
      Promise.all(
        PLATFORMS.map(async (d) => ({
          name: d.name,
          label: d.label,
          capabilities: d.capabilities,
          state: await client(d.name)
            .whoami()
            .then(
              (w) => (w.loggedIn ? (w.deliverTo ? "ready" : "logged in, no delivery address") : "not logged in"),
              (e) => reasonOf(e),
            ),
        })),
      ),
    ),
  );
}

function registerPlatformTools(server: McpServer, d: PlatformDescriptor): void {
  const p = (): Platform => client(d.name);
  const id = (verb: string) => `${d.name}_${verb}`;
  const L = d.label;
  /** Set when this process started a pay run, so a status file left by an earlier run isn't reported as this one. */
  let payStartedAt = 0;

  server.registerTool(
    id("session"),
    { description: `${L} session: logged in, and where it delivers.` },
    tool(() => p().whoami()),
  );
  if (can(d, "search")) {
    server.registerTool(
      id("search"),
      {
        description: `Search ${L}. Returns id, name, brand, unit, price, mrp, discountPct, inStock, url, related. related=true marks a store's 'related products' padding (not direct matches); they sort last. Use id with ${id("cart_add")}.`,
        inputSchema: { query: z.string(), ...where, ...filters, includeRelated: z.boolean().default(true) },
      },
      tool(({ query, ...o }: { query: string } & SearchOptions) => p().search(query, o)),
    );
  }
  if (can(d, "product")) {
    server.registerTool(
      id("product"),
      {
        description: `Full ${L} product details: price, stock, category breadcrumbs, attributes (nutrition, shelf life, seller…).`,
        inputSchema: { productId: z.string() },
      },
      tool(({ productId }: { productId: string }) => p().product(productId)),
    );
  }
  if (can(d, "categories")) {
    server.registerTool(
      id("categories"),
      {
        description: `Browse ${L}'s category tree. No argument: all groups and categories with subcategory names. With a group name: its categories. With a category name/id: its subcategories.`,
        inputSchema: { category: z.string().optional() },
      },
      tool(async ({ category }: { category?: string }) => {
        if (category) return p().findCategory?.(category);
        return ((await p().categories?.()) ?? []).map((g) => ({
          group: g.group,
          categories: g.categories.map((c) => ({
            id: c.id,
            name: c.name,
            subcategories: c.subcategories.map((s) => s.name),
          })),
        }));
      }),
    );
  }
  if (can(d, "browse")) {
    server.registerTool(
      id("browse"),
      {
        description: `List ${L} products in a subcategory (e.g. 'Milk', 'Chips & Wafers') or a whole category (e.g. 'Dairy, Bread & Eggs'), by name or id from ${id("categories")}. Same sort/filters as search.`,
        inputSchema: { category: z.string(), ...where, ...filters },
      },
      tool(({ category, ...o }: { category: string } & SearchOptions) => p().browse?.(category, o)),
    );
  }
  if (can(d, "locate")) {
    server.registerTool(
      id("locate"),
      {
        description: `Resolve an Indian 6-digit pincode to ${L} coordinates and serviceability (does not change the session).`,
        inputSchema: { pincode: z.string() },
      },
      tool(({ pincode }: { pincode: string }) => p().locate?.(pincode)),
    );
    server.registerTool(
      id("set_location"),
      {
        description: `Set the ${L} delivery area for search and cart without login (indicative prices). Clears any selected saved address.`,
        inputSchema: where,
      },
      tool((a: { pincode?: string; lat?: number; lon?: number }) => p().setLocation?.(a)),
    );
  }
  if (can(d, "login")) {
    server.registerTool(
      id("login_request_otp"),
      {
        description: `Send a ${L} login OTP by SMS to the user's own 10-digit mobile number, then ask the user for the code.`,
        inputSchema: { phone: z.string() },
      },
      tool(({ phone }: { phone: string }) => p().requestOtp(phone)),
    );
    server.registerTool(
      id("login_verify_otp"),
      {
        description: `Complete ${L} login with the OTP the user read from their SMS.`,
        inputSchema: { code: z.string() },
      },
      tool(({ code }: { code: string }) => p().verifyOtp(code)),
    );
    server.registerTool(
      id("logout"),
      { description: `Log out of ${L} and forget the saved session.` },
      tool(() => p().logout()),
    );
  }
  if (can(d, "addresses")) {
    server.registerTool(
      id("addresses"),
      { description: `List saved ${L} delivery addresses (id, label, text, selected). Requires login.` },
      tool(() => p().addresses()),
    );
    server.registerTool(
      id("use_address"),
      {
        description: `Deliver ${L} orders to a saved address, by label (e.g. 'Home'), id, or part of its text. Reprices the cart for that store.`,
        inputSchema: { address: z.string() },
      },
      tool(({ address }: { address: string }) => p().useAddress(address)),
    );
  }
  if (can(d, "cart")) {
    server.registerTool(
      id("cart"),
      { description: `Price the ${L} cart with the server: items, quantities, totals, and any problems.` },
      tool(() => p().cart()),
    );
    server.registerTool(
      id("cart_set"),
      {
        description: `Set an absolute quantity for one ${L} product; 0 removes it. Returns the priced cart.`,
        inputSchema: { productId: z.string(), quantity: z.number().int().min(0) },
      },
      tool(({ productId, quantity }: { productId: string; quantity: number }) => p().setQuantity(productId, quantity)),
    );
    server.registerTool(
      id("cart_add"),
      {
        description: `Add quantity of a ${L} product on top of what's in the cart.`,
        inputSchema: { productId: z.string(), quantity: z.number().int().min(1).default(1) },
      },
      tool(({ productId, quantity }: { productId: string; quantity: number }) => p().add(productId, quantity)),
    );
    server.registerTool(
      id("cart_clear"),
      { description: `Empty the ${L} cart.` },
      tool(() => p().clear()),
    );
  }
  if (can(d, "checkout")) {
    server.registerTool(
      id("checkout"),
      {
        description: `Validate the ${L} cart for the selected address and return the payable bill. Does not place the order. Show the bill to the user before ${id("pay")}.`,
      },
      tool(() => p().checkout()),
    );
  }
  if (can(d, "orders")) {
    server.registerTool(
      id("orders"),
      { description: `Recent ${L} orders, newest first.` },
      tool(() => p().orders?.()),
    );
  }
  if (can(d, "pay")) {
    server.registerTool(
      id("pay"),
      {
        description: `Pay the ${L} bill by UPI (headless). Only call after the user explicitly agrees to the exact amount from ${id("checkout")}; pass it as confirmAmount. Starts the payment in the background; poll ${id("pay_status")} until qr_ready. handoff "qrbaton" (default) gives a payLink: a page where the payer reviews the items and bill, taps Pay and approves in their UPI app, updated live when the payment completes. handoff "qr" gives just the UPI QR image to send.`,
        inputSchema: {
          confirmAmount: z.number(),
          handoff: z
            .enum(HANDOFFS)
            .default("qrbaton")
            .describe("qrbaton: pay page link (default). qr: just the UPI QR image."),
          agent: z.string().max(60).optional().describe("Your name, shown on the pay page as who prepared the order"),
          openPage: z
            .boolean()
            .optional()
            .describe("Also open the link / QR on this machine (default false for agents)"),
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
          const toPay = (await p().checkout()).total;
          if (Math.round(confirmAmount * 100) !== Math.round(toPay * 100)) {
            throw new HandcartError(
              `amount to pay is ₹${toPay}, not ₹${confirmAmount}; confirm the new amount with the user`,
            );
          }
          // Detached, so the payment outlives this server; the child writes the platform's status file.
          const args = [payBin(), d.name, "pay", "--confirm", String(toPay), "--handoff", handoff];
          if (agent) args.push("--agent", agent);
          if (!openPage) args.push("--no-open");
          payStartedAt = Date.now();
          const child = spawn(process.execPath, [...process.execArgv, ...args], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, ...p().payEnv?.() },
          });
          child.unref();
          return {
            started: true,
            amount: toPay,
            next: `poll ${id("pay_status")} until qr_ready, then send the user ${handoff === "qr" ? "the QR image" : "payLink"}`,
          };
        },
      ),
    );
    server.registerTool(
      id("pay_status"),
      {
        description: `Status of the last ${id("pay")}. Stages: starting | launching | qr_ready | paid | failed | timeout | browser_closed | unknown | error. unknown: the run ended without proof of payment; check the order history or the UPI app before paying again. On qr_ready: payLink (send it to the user) when handoff is qrbaton; otherwise the UPI QR is attached as an image (send that). qrExpiresAt: when the QR (and pay page) stops accepting payment, epoch ms; tell the payer how long they have. warning: something degraded, e.g. qrbaton was unavailable so only the QR is available. apiError: why the headless API fell back to the browser.`,
      },
      async () => {
        const s = p().payStatus?.() ?? ({ stage: "starting", ts: 0 } as PayStatus);
        // The child hasn't written yet: report this run rather than whatever the last one left behind.
        if (payStartedAt && s.ts < payStartedAt) return ok({ stage: "starting", ts: payStartedAt });
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
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "handcart", version: VERSION }, { instructions: INSTRUCTIONS });
  registerFanOutTools(server);
  for (const d of PLATFORMS) registerPlatformTools(server, d);
  return server;
}

export async function runMcp(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
