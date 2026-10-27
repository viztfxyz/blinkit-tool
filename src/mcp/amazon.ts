import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AmazonNow } from "../amazon/client.js";
import { OTP_CHANNELS, type OtpChannel } from "../amazon/login.js";
import { billProblem, readNowPayStatus } from "../amazon/pay.js";
import { BlinkitError } from "../core/errors.js";
import { HANDOFFS, type Handoff } from "../pay/status.js";
import { ok, tool } from "./tools.js";

export const AMAZON_INSTRUCTIONS = `Amazon Now (amazon.in 10-minute delivery) tools, separate from Blinkit:
amazon_now_session → (if not logged in) amazon_now_login_request_otp + amazon_now_login_verify_otp →
(optional) amazon_now_addresses + amazon_now_use_address → amazon_now_search → amazon_now_cart_set (by ASIN) → amazon_now_checkout → (user confirms the amount)
amazon_now_pay → amazon_now_pay_status → send the payLink (or, with handoff "qr", the QR image).
Delivery goes to the selected saved address (amazon_now_session / amazon_now_addresses); confirm it with the user.
Amazon Now pay always uses a UPI QR and never Amazon Pay balance.`;

export function registerAmazonTools(server: McpServer, now = new AmazonNow()): void {
  server.registerTool(
    "amazon_now_session",
    { description: "Amazon Now login state and delivery address. Start here for Amazon Now." },
    tool(() => now.whoami()),
  );
  server.registerTool(
    "amazon_now_login_request_otp",
    {
      description:
        "Start Amazon login: sends an OTP (SMS by default) to the user's Amazon mobile number. Only for a number the user gave you. Then ask the user for the code and call amazon_now_login_verify_otp.",
      inputSchema: { phone: z.string(), via: z.enum(OTP_CHANNELS).default("sms") },
    },
    tool(({ phone, via }: { phone: string; via: OtpChannel }) => now.requestOtp(phone, via)),
  );
  server.registerTool(
    "amazon_now_login_verify_otp",
    {
      description: "Finish Amazon login with the OTP the user received.",
      inputSchema: { code: z.string() },
    },
    tool(({ code }: { code: string }) => now.verifyOtp(code)),
  );
  server.registerTool(
    "amazon_now_logout",
    { description: "Forget the Amazon session." },
    tool(() => now.logout()),
  );
  server.registerTool(
    "amazon_now_addresses",
    {
      description:
        "Saved Amazon addresses: id, label, text, serviceable (Amazon Now delivers there), selected (in use), isDefault.",
    },
    tool(() => now.addresses()),
  );
  server.registerTool(
    "amazon_now_use_address",
    {
      description:
        "Deliver to a saved address, by label, id, or part of the address text. Only serviceable addresses. Prices and stock can change with the address, so re-check the cart and bill.",
      inputSchema: { which: z.string() },
    },
    tool(({ which }: { which: string }) => now.useAddress(which)),
  );
  server.registerTool(
    "amazon_now_search",
    {
      description:
        "Search Amazon Now at the account's delivery address. Returns asin, name, unit, price, mrp, discountPct, inStock. Use asin with amazon_now_cart_set.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(60).default(12),
        inStock: z.boolean().default(false),
      },
    },
    tool(({ query, limit, inStock }: { query: string; limit: number; inStock: boolean }) =>
      now.search(query, { limit, inStock }),
    ),
  );
  server.registerTool(
    "amazon_now_product",
    { description: "One Amazon Now product by ASIN.", inputSchema: { asin: z.string() } },
    tool(({ asin }: { asin: string }) => now.product(asin)),
  );
  server.registerTool(
    "amazon_now_cart",
    { description: "The Amazon Now cart." },
    tool(() => now.cart()),
  );
  server.registerTool(
    "amazon_now_cart_set",
    {
      description: "Set absolute quantities in the Amazon Now cart (0 removes). Returns the cart.",
      inputSchema: {
        items: z.array(z.object({ asin: z.string(), quantity: z.number().int().min(0) })).min(1),
      },
    },
    tool(async ({ items }: { items: { asin: string; quantity: number }[] }) => {
      for (const i of items) await now.setQuantity(i.asin, i.quantity);
      return now.cart();
    }),
  );
  server.registerTool(
    "amazon_now_cart_clear",
    { description: "Empty the Amazon Now cart." },
    tool(() => now.clear()),
  );
  server.registerTool(
    "amazon_now_checkout",
    {
      description:
        "The payable Amazon Now bill (items, fees, total, delivery address, ETA). Does not place the order. Show it to the user before amazon_now_pay.",
    },
    tool(() => now.checkout()),
  );
  server.registerTool(
    "amazon_now_orders",
    { description: "Active Amazon Now orders with delivery and payment state." },
    tool(() => now.orders()),
  );
  server.registerTool(
    "amazon_now_pay",
    {
      description:
        'Place the Amazon Now order and pay by UPI QR ("Scan and Pay with UPI"); never uses Amazon Pay balance. Only call after the user explicitly agrees to the exact total from amazon_now_checkout; pass it as confirmAmount. Starts in the background; poll amazon_now_pay_status until qr_ready. The QR is valid for about 10 minutes; an unpaid order is cancelled by Amazon.',
      inputSchema: {
        confirmAmount: z.number(),
        handoff: z.enum(HANDOFFS).default("qrbaton").describe("qrbaton: pay page link (default). qr: the QR image."),
        agent: z.string().max(60).optional().describe("Your name, shown on the pay page as who prepared the order"),
        openPage: z.boolean().optional().describe("Also open the link / QR on this machine (default false)"),
      },
    },
    tool(async (a: { confirmAmount: number; handoff: Handoff; agent?: string; openPage?: boolean }) => {
      const bill = await now.checkout();
      const problem = billProblem(bill, a.confirmAmount);
      if (problem) throw new BlinkitError(problem);
      const bin = import.meta.url.endsWith(".ts") ? "../bin/blinkit.ts" : "../bin/blinkit.js";
      const args = [fileURLToPath(new URL(bin, import.meta.url)), "amazon", "pay", "--confirm", String(bill.total)];
      args.push("--handoff", a.handoff);
      if (a.agent) args.push("--agent", a.agent);
      if (!a.openPage) args.push("--no-open");
      spawn(process.execPath, [...process.execArgv, ...args], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, AMAZON_NOW_COOKIES: now.session.cookieFile },
      }).unref();
      return {
        started: true,
        amount: bill.total,
        next: `poll amazon_now_pay_status until qr_ready, then send the user ${a.handoff === "qr" ? "the QR image" : "payLink"}`,
      };
    }),
  );
  server.registerTool(
    "amazon_now_pay_status",
    {
      description:
        "Status of the last amazon_now_pay. Stages: launching | qr_ready | paid | failed | timeout | error. On qr_ready: payLink (send it) with handoff qrbaton, otherwise the UPI QR is attached as an image. qrExpiresAt: when the QR stops accepting payment (epoch ms).",
    },
    async () => {
      const s = readNowPayStatus();
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
