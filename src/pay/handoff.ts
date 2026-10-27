/**
 * Getting the UPI payment to the payer. "qrbaton" (default) posts the UPI intent, or the QR image,
 * plus the cart to https://qrbaton.vercel.app and returns a pay page link: the payer reviews the
 * order and taps Pay to open their UPI app. No API key needed. "qr" skips that and just returns the
 * UPI QR as a PNG (and the upi:// string) for the agent or user to pass on.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { BASE, paths, QRBATON_URL } from "../core/config.js";
import type { Cart, SelectedAddress } from "../types.js";
import { writeQr } from "./qr.js";
import type { Handoff, PayStage } from "./status.js";

export interface HandoffInput {
  cart: Cart;
  address?: SelectedAddress;
  amount: number;
  orderId?: number;
  /** The upi://pay intent, when known. */
  upiIntent?: string | null;
  /** The captured QR image, used when the intent could not be read. */
  qrPng?: Buffer;
  /** Who is paying on whose behalf, shown on the qrbaton page (e.g. "Claude"). */
  agent?: string;
  /** How long the pay page stays open. */
  ttlSec?: number;
  /** When the UPI QR stops accepting payment (epoch ms), as zpaykit reports it. Caps the pay page's life. */
  qrExpiresAt?: number;
}

export interface HandoffResult {
  handoff: Handoff;
  qrImage: string;
  upiIntent?: string;
  payLink?: string;
  sessionId?: string;
  /** Bearer token for updating the qrbaton page's status. Kept in memory only. */
  manageToken?: string;
  /** When the UPI QR stops accepting payment (epoch ms), if known. */
  qrExpiresAt?: number;
  warning?: string;
}

/** Order summary accepted by qrbaton's POST /api/sessions (https://qrbaton.vercel.app/openapi.json). */
export interface QrbatonOrder {
  merchant: string;
  site: string;
  agent?: string;
  total: number;
  items: { name: string; unit?: string; qty: number; price: number; mrp?: number; image?: string }[];
  /** The bill as Blinkit shows it, top to bottom; discounts are negative. */
  charges: { label: string; amount: number }[];
  delivery?: { slot?: string; address?: { label?: string; text?: string } };
  orderId?: string;
}

export type QrbatonStatus = "paid" | "failed" | "expired";

const round2 = (n: number) => Math.round(n * 100) / 100;
const label = (k: string) => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const https = (s: string | null) => (s && /^https:\/\//i.test(s) ? s : undefined);

export function qrbatonOrder(input: HandoffInput): QrbatonOrder {
  const { cart, address } = input;
  const b = cart.bill;
  const charges = [
    { label: "Items", amount: b.itemsMrp || b.itemsTotal },
    ...(b.itemsMrp && b.productDiscount ? [{ label: "Saved on MRP", amount: -b.productDiscount }] : []),
    { label: "Delivery", amount: b.deliveryCharge },
    ...Object.entries(b.chargesBreakdown).map(([k, v]) => ({ label: label(k), amount: v })),
    ...(b.promoDiscount ? [{ label: "Promo", amount: -b.promoDiscount }] : []),
  ].filter((c) => c.amount !== 0 || c.label === "Delivery");
  const slot = cart.delivery[0]?.slot;
  return {
    merchant: "Blinkit",
    site: BASE,
    ...(input.agent ? { agent: input.agent.slice(0, 60) } : {}),
    total: round2(input.amount),
    items: cart.items.map((i) => ({
      name: i.name,
      ...(i.unit ? { unit: i.unit } : {}),
      qty: i.quantity,
      price: round2(i.price),
      ...(i.mrp > i.price ? { mrp: round2(i.mrp) } : {}),
      ...(https(i.image) ? { image: https(i.image) } : {}),
    })),
    charges: charges.map((c) => ({ label: c.label, amount: round2(c.amount) })),
    ...(slot || address
      ? {
          delivery: {
            ...(slot ? { slot } : {}),
            ...(address ? { address: { label: address.label, text: address.text } } : {}),
          },
        }
      : {}),
    ...(input.orderId ? { orderId: String(input.orderId) } : {}),
  };
}

/**
 * Seconds the qrbaton page should accept payment: `ttlSec`, cut short to when the QR expires so the
 * page never offers a dead QR. Within qrbaton's 60–86400 limits; undefined leaves qrbaton's default.
 */
export function payPageTtlSec(
  input: Pick<HandoffInput, "ttlSec" | "qrExpiresAt">,
  now = Date.now(),
): number | undefined {
  const untilExpiry = input.qrExpiresAt ? (input.qrExpiresAt - now) / 1000 : undefined;
  const ttl = Math.min(input.ttlSec ?? Infinity, untilExpiry ?? Infinity);
  return Number.isFinite(ttl) ? Math.min(86400, Math.max(60, Math.round(ttl))) : undefined;
}

/** Write the QR and, for "qrbaton", create the pay page. Falls back to the bare QR if qrbaton fails. */
export async function handOff(mode: Handoff, input: HandoffInput): Promise<HandoffResult> {
  const upiIntent = input.upiIntent ?? undefined;
  const qrImage = await writeQr(paths.qr, { upiIntent, png: input.qrPng });
  const qrOnly: HandoffResult = {
    handoff: "qr",
    qrImage,
    ...(upiIntent ? { upiIntent } : {}),
    ...(input.qrExpiresAt ? { qrExpiresAt: input.qrExpiresAt } : {}),
  };
  if (mode === "qr") return qrOnly;
  const ttlSec = payPageTtlSec(input);
  try {
    const r = await fetch(`${QRBATON_URL}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(upiIntent ? { upi: upiIntent } : { qr: readFileSync(qrImage).toString("base64") }),
        order: qrbatonOrder(input),
        ...(ttlSec ? { ttlSec } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json().catch(() => ({}))) as {
      id?: string;
      url?: string;
      manageToken?: string;
      error?: string;
    };
    if (!r.ok || !body.id || !body.url) {
      return {
        ...qrOnly,
        warning: `qrbaton refused the pay page (HTTP ${r.status}${body.error ? `: ${body.error}` : ""}); send the QR instead`,
      };
    }
    return { ...qrOnly, handoff: "qrbaton", payLink: body.url, sessionId: body.id, manageToken: body.manageToken };
  } catch (e) {
    return { ...qrOnly, warning: `qrbaton unreachable (${(e as Error).message}); send the QR instead` };
  }
}

/** The qrbaton status for a terminal pay stage; abandoned and crashed runs count as expired. */
export function qrbatonStatusFor(stage: PayStage): QrbatonStatus | null {
  switch (stage) {
    case "paid":
      return "paid";
    case "failed":
      return "failed";
    case "timeout":
    case "browser_closed":
    case "error":
      return "expired";
    case "starting":
    case "launching":
    case "qr_ready":
    case "dry_run_ok":
      return null;
    default: {
      const _exhaustive: never = stage;
      return _exhaustive;
    }
  }
}

/** Tell the open pay page how the payment ended. Best effort: the page also expires on its own. */
export async function reportStatus(r: HandoffResult | undefined, status: QrbatonStatus): Promise<void> {
  if (!r?.sessionId || !r.manageToken) return;
  try {
    await fetch(`${QRBATON_URL}/api/sessions/${r.sessionId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${r.manageToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

/** Open a URL or file with the OS default handler. */
export function openUrl(target: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target.replace(/&/g, "^&")] : [target];
  spawn(cmd, args, { detached: true, stdio: "ignore" })
    .on("error", () => undefined)
    .unref();
}
