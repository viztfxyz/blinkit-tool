/**
 * Pay for the Zepto cart by UPI QR ("Pay via QR Code"), never with Zepto Cash or a wallet. All HTTP:
 *
 *   1. Price the cart with useZeptoCash: false; refuse unless the total is the confirmed amount, no wallet
 *      money is applied, and Zepto reports no problem.
 *   2. Ask Zepto's payment page which instruments it offers; refuse unless "Pay via QR Code" (UPI_QR) is up.
 *      `--dry-run` stops here.
 *   3. Create the order with UPI_QR as the instrument. That places the order; Zepto answers with the QR.
 *   4. Decode the QR (a plain upi://pay intent), check its amount, hand it over as a qrbaton pay page or a
 *      PNG, and poll the payment until it is paid, fails, or the QR expires.
 */
import { randomUUID } from "node:crypto";
import { HandcartError } from "../../core/errors.js";
import type { Json } from "../../core/types.js";
import { upiAmount, upiExpiry } from "../../core/upi.js";
import {
  type HandoffResult,
  handOffOrder,
  openUrl,
  type QrbatonOrder,
  qrbatonStatusFor,
  reportStatus,
} from "../../pay/handoff.js";
import { decodeQrPng } from "../../pay/qr.js";
import { type Handoff, type PayStage, readPayStatus, writePayStatus } from "../../pay/status.js";
import type { PricedCart } from "./client.js";
import { ZEPTO_BASE, zeptoPaths } from "./config.js";
import { payOutcome } from "./parsing.js";
import type { ZeptoSession } from "./session.js";
import type { ZeptoBill, ZeptoPayStatus } from "./types.js";

export interface ZeptoPayOptions {
  /** Must equal the bill total from `checkout`, or nothing happens. */
  confirmAmount: number;
  /** Seconds to wait for the payment; the wait also ends when the QR expires. */
  timeoutSec?: number;
  /** Stop after checking the bill and that Zepto offers the UPI QR, before placing the order. */
  dryRun?: boolean;
  handoff?: Handoff;
  agent?: string;
  openPage?: boolean;
  log?: (msg: string) => void;
}

export interface ZeptoPayDeps {
  session: ZeptoSession;
  price(): Promise<PricedCart>;
  /** Called once the payment lands: Zepto's cart lives on the client, so emptying it is ours to do. */
  clearCart(): void;
}

/** The only instrument pay will ever send. */
export const UPI_QR = { paymentInstrumentGroup: "UPI", paymentInstrumentCode: "UPI_QR" } as const;

const paise = (n: number) => Math.round(n * 100);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Why the bill must not be paid, or null. */
export function billProblem(bill: ZeptoBill, confirmAmount: number): string | null {
  if (!Number.isFinite(confirmAmount) || paise(confirmAmount) !== paise(bill.total)) {
    return `amount to pay is ₹${bill.total}, not ₹${confirmAmount}; confirm ₹${bill.total} to proceed`;
  }
  if (bill.walletApplied > 0) return `Zepto applied ₹${bill.walletApplied} of Zepto Cash / wallet; refusing to pay`;
  if (bill.issues.length) return `Zepto reports a problem with this checkout: ${bill.issues.join(", ")}`;
  if (bill.paymentFlow !== "IPP") {
    return `Zepto wants a different payment flow for this cart (${bill.paymentFlow ?? "none"}); pay on zepto.com instead`;
  }
  return null;
}

/** The "Pay via QR Code" row on Zepto's payment page (payment-listing-api/v1/ipp), or null. */
export function findUpiQr(listing: Json): Json | null {
  for (const w of listing?.data?.pageLayout?.widgets ?? []) {
    for (const item of w?.data?.items ?? []) {
      for (const row of item?.data ?? []) {
        const info = row?.paymentInfo;
        if (info?.paymentInstrumentCode === UPI_QR.paymentInstrumentCode) return row;
      }
    }
  }
  return null;
}

/** Why the payment page doesn't allow the UPI QR for this amount, or null. */
export function listingProblem(listing: Json, amount: number): string | null {
  const shown = listing?.data?.pageLayout?.pageMeta?.amountToPay;
  if (shown != null && Number(shown) !== paise(amount)) {
    return `Zepto's payment page asks for ₹${Number(shown) / 100}, expected ₹${amount}`;
  }
  const row = findUpiQr(listing);
  if (!row) return 'Zepto didn\'t offer "Pay via QR Code" for this order';
  if (row.outageStatus && row.outageStatus !== "UP")
    return `Zepto's UPI QR is unavailable right now (${row.outageStatus})`;
  return null;
}

/** Order summary for the qrbaton pay page. */
export function zeptoQrbatonOrder(bill: ZeptoBill, agent?: string, orderId?: string): QrbatonOrder {
  const https = (s: string | null | undefined) => (s && /^https:\/\//i.test(s) ? s : undefined);
  const items = bill.lines.find((l) => l.type === "ITEM_TOTAL");
  const itemsMrp = items?.listAmount ?? items?.amount ?? bill.total;
  const saved = itemsMrp - (items?.amount ?? itemsMrp);
  return {
    merchant: "Zepto",
    site: ZEPTO_BASE,
    ...(agent ? { agent: agent.slice(0, 60) } : {}),
    total: bill.total,
    items: bill.items.map((i) => ({
      name: i.name,
      ...(i.unit ? { unit: i.unit } : {}),
      qty: i.quantity,
      price: i.price,
      ...(i.mrp > i.price ? { mrp: i.mrp } : {}),
      ...(https(i.image) ? { image: https(i.image) } : {}),
    })),
    charges: [
      { label: "Items", amount: itemsMrp },
      ...(saved > 0 ? [{ label: "Saved on MRP", amount: -saved }] : []),
      ...bill.lines
        .filter((l) => l !== items && (l.amount !== 0 || /DELIVERY/.test(l.type)))
        .map((l) => ({ label: l.label, amount: l.amount })),
    ],
    ...(bill.address ? { delivery: { address: { text: bill.address } } } : {}),
    ...(orderId ? { orderId } : {}),
  };
}

const status = (s: Omit<ZeptoPayStatus, "ts">) => writePayStatus<ZeptoPayStatus>(s, zeptoPaths.payStatus);
export const readZeptoPayStatus = () => readPayStatus<ZeptoPayStatus>(zeptoPaths.payStatus);

/** The QR image Zepto returns: a data: URL or an https URL. */
async function qrImage(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new HandcartError(`couldn't download Zepto's QR (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

export async function payZepto(deps: ZeptoPayDeps, opts: ZeptoPayOptions): Promise<ZeptoPayStatus> {
  const log = opts.log ?? console.log;
  const mode = opts.handoff ?? "qrbaton";
  deps.session.requireLogin();
  const priced = await deps.price();
  const { bill, raw, request } = priced;
  const problem = billProblem(bill, opts.confirmAmount);
  if (problem) throw new HandcartError(problem);
  const amount = bill.total;
  const base = { amount, handoff: mode };
  status({ ...base, stage: "launching" });

  let order: Json;
  try {
    log("Checking Zepto's payment options…");
    const listing = await deps.session.api("POST", "payment-service/payment-listing-api/v1/ipp", {
      json: {
        installedUpiApps: [],
        source: "cart",
        sourceId: bill.cartId,
        isCredPayEligible: false,
        sourceToken: raw?.encryptedSummary ?? "",
      },
    });
    const lp = listingProblem(listing, amount);
    if (lp) throw new HandcartError(lp);
    if (opts.dryRun) {
      log(`Dry run: Zepto offers Pay via QR Code for ₹${amount}, no Zepto Cash used. Stopping before the order.`);
      return status({ ...base, stage: "dry_run_ok" });
    }
    log(`Placing the order (₹${amount}, UPI QR)…`);
    order = await deps.session.api("POST", "api/v3/order/", {
      headers: { storeId: request.storeId },
      json: {
        latitude: request.latitude,
        longitude: request.longitude,
        useZeptoCash: false,
        storeId: request.storeId,
        noBagDelivery: false,
        previousCartDetails: { toPay: paise(amount) },
        paymentMetadata: {
          ...UPI_QR,
          data: {},
          returnUrlOrigin: `${ZEPTO_BASE}/ProcessOrder`,
          returnUrlEnabled: false,
          ad: false,
          isProductBasketRequired: true,
        },
        appPlatform: "MWEB",
        returnUrlEnabled: true,
        removeCampaignProductsList: [],
        cartId: bill.cartId,
        // Idempotency key: a retried request can't create a second order.
        checkoutMeta: { id: randomUUID(), count: 1 },
      },
    });
    if (!order?.isOrderCreated || !order?.id) {
      throw new HandcartError(`Zepto didn't create the order${order?.message ? `: ${order.message}` : ""}`);
    }
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    status({ ...base, stage: "error", error });
    throw e;
  }

  // The order exists from here on: never start a second payment, just report.
  const zeptoOrderId = String(order.id);
  const info = order.paymentInfo ?? {};
  const paymentId = info.paymentId ? String(info.paymentId) : undefined;
  const meta = info.data?.paymentInstrumentMetadata ?? {};
  const placed = { ...base, zeptoOrderId, paymentId };
  const fail = (error: string) => {
    status({ ...placed, stage: "error", error });
    return new HandcartError(error);
  };
  if (info.paymentInstrumentCode && info.paymentInstrumentCode !== UPI_QR.paymentInstrumentCode) {
    throw fail(`Zepto set up ${info.paymentInstrumentCode} instead of a UPI QR; not handing anything out`);
  }
  if (!meta.qrUrl || !paymentId) throw fail(`Zepto placed order ${zeptoOrderId} but returned no QR`);
  const png = await qrImage(String(meta.qrUrl)).catch((e) => {
    throw fail(`Zepto placed order ${zeptoOrderId} but its QR couldn't be fetched: ${(e as Error).message}`);
  });
  const upiIntent = decodeQrPng(png);
  const qrAmount = upiIntent ? upiAmount(upiIntent) : null;
  if (upiIntent && (qrAmount == null || paise(qrAmount) !== paise(amount))) {
    throw fail(`Zepto's QR is for ₹${qrAmount ?? "?"}, not ₹${amount}; not handing it out`);
  }
  const timer = Number(meta.timerDuration);
  const expiries = [
    upiIntent ? upiExpiry(upiIntent) : null,
    Date.now() + (Number.isFinite(timer) && timer > 0 ? timer : 300) * 1000,
  ].filter((t): t is number => t != null);
  const expiresAt = Math.min(...expiries);
  const deadline = Math.min(Date.now() + (opts.timeoutSec ?? 600) * 1000, expiresAt + 30_000);
  const link: HandoffResult = await handOffOrder(mode, {
    order: zeptoQrbatonOrder(bill, opts.agent, zeptoOrderId),
    upiIntent,
    qrPng: png,
    ttlSec: Math.max(60, Math.round((Math.min(deadline, expiresAt) - Date.now()) / 1000)),
    qrPath: zeptoPaths.qr,
  });
  const ready = {
    ...placed,
    handoff: link.handoff,
    qrImage: link.qrImage,
    qrExpiresAt: expiresAt,
    ...(upiIntent ? { upiIntent } : {}),
    ...(link.payLink ? { payLink: link.payLink, sessionId: link.sessionId } : {}),
    ...(link.warning || !upiIntent
      ? { warning: link.warning ?? "couldn't read the QR's UPI link; the amount inside it wasn't checked" }
      : {}),
  };
  status({ ...ready, stage: "qr_ready" });
  announce(link, amount, ready.warning, opts, log);
  log(`QR valid until ${new Date(expiresAt).toLocaleTimeString()}.`);

  const finish = async (stage: PayStage, extra: Partial<ZeptoPayStatus> = {}) => {
    const s = qrbatonStatusFor(stage);
    if (s) await reportStatus(link, s);
    return status({ ...ready, ...extra, stage });
  };
  let last = "";
  while (Date.now() < deadline) {
    await sleep(4000);
    try {
      const r = await deps.session.api("GET", `payment-service/api/v1/payment/${paymentId}/payment-id-status`);
      last = String(r?.data?.status ?? "");
      const reason = String(r?.data?.failureReason ?? "");
      const outcome = payOutcome(last);
      if (outcome === "paid") {
        log("Payment received.");
        deps.clearCart();
        return finish("paid", { zeptoStatus: last });
      }
      if (outcome === "failed") {
        // Seen live: an unpaid QR ends FAILED with failureReason PAYMENT_THRESHOLD_TIMEOUT, and Zepto cancels the order.
        const expired = /TIMEOUT|EXPIR/i.test(reason) || Date.now() >= expiresAt - 5000;
        const why = [last, reason].filter(Boolean).join(", ");
        log(`Payment ${expired ? "expired" : "failed"} (${why}).`);
        return finish(expired ? "timeout" : "failed", { zeptoStatus: why });
      }
    } catch {
      // transient; keep polling until the deadline
    }
  }
  return finish("timeout", { zeptoStatus: last || undefined });
}

function announce(
  link: HandoffResult,
  amount: number,
  warning: string | undefined,
  opts: ZeptoPayOptions,
  log: (m: string) => void,
) {
  if (warning) log(`warning: ${warning}`);
  const open = opts.openPage !== false;
  if (link.payLink) {
    if (open) openUrl(link.payLink);
    log(`Pay link${open ? " (opened)" : ""}: ${link.payLink}`);
    log(`UPI QR also saved at ${link.qrImage}`);
  } else {
    if (open) openUrl(link.qrImage);
    log(`UPI QR for ₹${amount}${open ? " (opened)" : ""}: ${link.qrImage}`);
    if (link.upiIntent) log(`UPI link: ${link.upiIntent}`);
  }
  log("Scan with any UPI app (GPay, PhonePe, Paytm…) and approve. Waiting…");
}
