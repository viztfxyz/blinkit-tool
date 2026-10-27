/**
 * Pay for the Amazon Now cart by UPI QR ("Scan and Pay with UPI"), never with Amazon Pay balance.
 *
 *   1. HTTP: build the bill; refuse unless its total is the confirmed amount and no balance is applied.
 *   2. Chromium: cart → "Proceed to pay" → Amazon's payment page. Amazon pre-selects the Amazon Pay
 *      balance there, so we select "Scan and Pay with UPI" and check that it is the *only* selection
 *      before pressing "Pay ₹<amount>". That press places the order; Amazon then shows the UPI QR.
 *   3. Decode the QR (a plain merchant upi://pay intent, like a shop's QR), check its amount, and hand
 *      it over as a qrbaton pay page or a PNG. The browser closes; nothing else needs it.
 *   4. HTTP: poll /aips/get-status until Amazon reports the payment done, failed, or the QR expires.
 */
import type { Locator, Page } from "playwright-core";
import { BlinkitError } from "../core/errors.js";
import { RECONFIRM_AMAZON } from "../core/fixes.js";
import {
  type HandoffResult,
  handOffOrder,
  openUrl,
  type QrbatonOrder,
  qrbatonStatusFor,
  reportStatus,
} from "../pay/handoff.js";
import { decodeQrPng } from "../pay/qr.js";
import { type Handoff, type PayStage, readPayStatus, writePayStatus } from "../pay/status.js";
import { type NowBrowser, openBrowser, snapshot } from "./browser.js";
import { AMAZON_BASE, amazonPaths, NOW_CART } from "./config.js";
import { type NowPayOutcome, payOutcome, upiAmount, upiExpiry } from "./parsing.js";
import type { NowSession } from "./session.js";
import type { NowBill, NowCart, NowPayStatus } from "./types.js";

export interface NowPayOptions {
  /** Must equal the bill total from `checkout`, or nothing happens. */
  confirmAmount: number;
  /** Seconds to wait for the payment; the wait also ends when the QR expires (read from the QR itself). */
  timeoutSec?: number;
  /** Stop on the payment page with Scan & Pay UPI selected, before placing the order. */
  dryRun?: boolean;
  handoff?: Handoff;
  agent?: string;
  openPage?: boolean;
  log?: (msg: string) => void;
}

/** What `checkout` and the cart give pay; injected so the flow doesn't depend on the client class. */
export interface NowPayDeps {
  session: NowSession;
  checkout(): Promise<NowBill>;
  cart(): Promise<NowCart>;
}

const paise = (n: number) => Math.round(n * 100);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Why the bill must not be paid, or null. */
/** The fix for a `billProblem`: an amount mismatch means re-confirming against the fresh bill. */
export const problemFix = (problem: string) => (/^amount to pay/.test(problem) ? RECONFIRM_AMAZON : undefined);

export function billProblem(bill: NowBill, confirmAmount: number): string | null {
  if (!Number.isFinite(confirmAmount) || paise(confirmAmount) !== paise(bill.total)) {
    return `amount to pay is ₹${bill.total}, not ₹${confirmAmount}; confirm ₹${bill.total} to proceed`;
  }
  if (bill.balanceApplied > 0) return `Amazon applied ₹${bill.balanceApplied} of Amazon Pay balance; refusing to pay`;
  if (bill.issues.length) return `Amazon reports a problem with this checkout: ${bill.issues.join(", ")}`;
  if (!bill.items.length) return "the Amazon Now cart is empty";
  return null;
}

/** What the payment page shows right before "Pay": every checked input, the total and the pay buttons. */
export interface PaymentPageState {
  checked: { type: string; name: string; value: string; label: string }[];
  orderTotal: number | null;
  payButtons: string[];
}

const BALANCE = /APB|gcInstrumentId|balance|gift ?card|giftcard/i;
const isUpiQr = (c: PaymentPageState["checked"][number]) =>
  /paymentMethod=UnifiedPaymentsInterface/.test(c.value) && /scan and pay/i.test(c.label);

/** Why the payment page must not be submitted, or null when only Scan & Pay UPI is selected for the amount. */
export function paymentPageProblem(s: PaymentPageState, amount: number): string | null {
  const balance = s.checked.find((c) => BALANCE.test(`${c.name} ${c.value} ${c.label}`));
  if (balance)
    return `Amazon Pay balance is selected on the payment page ("${balance.label.slice(0, 60)}"); refusing to pay`;
  if (s.checked.length !== 1 || !isUpiQr(s.checked[0])) {
    return `expected only "Scan and Pay with UPI" to be selected, found: ${s.checked.map((c) => c.label.slice(0, 40) || c.name).join(" | ") || "nothing"}`;
  }
  if (s.orderTotal == null || paise(s.orderTotal) !== paise(amount)) {
    return `payment page total is ₹${s.orderTotal ?? "?"}, expected ₹${amount}`;
  }
  const label = `Pay ₹${amount.toFixed(2)}`;
  if (!s.payButtons.includes(label))
    return `no "${label}" button on the payment page (saw: ${s.payButtons.join(", ")})`;
  return null;
}

/** Serialized into the page by Playwright: reads every checked radio/checkbox with its visible label. */
// No named inner functions here: tsx/esbuild would wrap them in a `__name` helper the page lacks.
function readPaymentPage(): PaymentPageState {
  const checked: PaymentPageState["checked"] = [];
  for (const e of document.querySelectorAll<HTMLInputElement>("input[type=radio], input[type=checkbox]")) {
    if (!e.checked) continue;
    // The label sits a few levels up from the input, next to it in Amazon's grid.
    let n: HTMLElement | null = e;
    for (let k = 0; k < 6 && n && (n.innerText ?? "").trim().length < 12; k++) n = n.parentElement;
    checked.push({
      type: e.type,
      name: e.name,
      value: e.value,
      label: (n?.innerText ?? "").replace(/\s+/g, " ").trim(),
    });
  }
  const text = document.body.innerText.replace(/\s+/g, " ");
  const total = text.match(/Order Total\s*₹\s*([\d,]+(?:\.\d+)?)/)?.[1];
  const payButtons = [...document.querySelectorAll<HTMLInputElement>("input[type=submit][aria-labelledby]")]
    .filter((e) => e.offsetParent)
    .map((e) => document.getElementById(e.getAttribute("aria-labelledby") ?? "")?.innerText.trim() ?? "")
    .filter(Boolean);
  return { checked, orderTotal: total ? Number(total.replace(/,/g, "")) : null, payButtons };
}

/** Order summary for the qrbaton pay page. */
export function nowQrbatonOrder(bill: NowBill, cart: NowCart, agent?: string): QrbatonOrder {
  const names = new Map(cart.items.map((i) => [i.asin, i]));
  const itemsLine = bill.lines.find((l) => l.type === "ITEM_TOTAL_TAX_INCLUSIVE");
  const itemsMrp = itemsLine?.listAmount ?? itemsLine?.amount ?? bill.total;
  const saved = itemsMrp - (itemsLine?.amount ?? itemsMrp);
  const https = (s: string | null | undefined) => (s && /^https:\/\//i.test(s) ? s : undefined);
  return {
    merchant: "Amazon Now",
    site: AMAZON_BASE,
    ...(agent ? { agent: agent.slice(0, 60) } : {}),
    total: bill.total,
    items: bill.items.map((i) => {
      const c = names.get(i.asin);
      return {
        name: c?.name ?? i.asin,
        ...(c?.unit ? { unit: c.unit } : {}),
        qty: i.quantity,
        price: i.price,
        ...(i.mrp > i.price ? { mrp: i.mrp } : {}),
        ...(https(c?.image) ? { image: https(c?.image) } : {}),
      };
    }),
    charges: [
      { label: "Items", amount: itemsMrp },
      ...(saved > 0 ? [{ label: "Saved on MRP", amount: -saved }] : []),
      ...bill.lines
        .filter((l) => l !== itemsLine && (l.amount !== 0 || /DELIVERY/.test(l.type)))
        .map((l) => ({ label: l.label, amount: l.amount })),
    ],
    ...(bill.address ? { delivery: { address: { text: bill.address } } } : {}),
    orderId: bill.purchaseId,
  };
}

const status = (s: Omit<NowPayStatus, "ts">) => writePayStatus<NowPayStatus>(s, amazonPaths.payStatus);
export const readNowPayStatus = () => readPayStatus<NowPayStatus>(amazonPaths.payStatus);

/** Cart page → Amazon's payment page, making sure "Use Amazon Pay Balance" is off on the way. */
async function toPaymentPage(page: Page, log: (m: string) => void): Promise<void> {
  await page.goto(NOW_CART, { waitUntil: "domcontentloaded" });
  const proceed = page.getByRole("button", { name: "Proceed to pay" });
  await proceed.first().waitFor({ state: "visible", timeout: 30000 });
  const balanceBox = page.locator("#amazon-pay-balance-checkbox");
  for (
    let i = 0;
    i < 2 && (await balanceBox.evaluateAll((els) => els.some((e) => (e as HTMLInputElement).checked)));
    i++
  ) {
    log("Turning off “Use Amazon Pay Balance”…");
    await balanceBox.first().uncheck({ force: true });
    await sleep(1500);
  }
  if (await balanceBox.evaluateAll((els) => els.some((e) => (e as HTMLInputElement).checked))) {
    throw new BlinkitError("couldn't turn off “Use Amazon Pay Balance” on the cart; refusing to pay");
  }
  // The first press can open an upsell drawer with its own "Proceed to pay".
  for (let attempt = 0; attempt < 3 && !page.url().includes("/pay-checkout/"); attempt++) {
    await proceed.last().click({ timeout: 10000 });
    await page.waitForURL(/\/pay-checkout\//, { timeout: 10000 }).catch(() => undefined);
  }
  if (!page.url().includes("/pay-checkout/")) {
    throw new BlinkitError(`Amazon didn't open the payment page (${await snapshot(page)})`);
  }
}

/**
 * Pick "Scan and Pay with UPI". Amazon pre-selects the Amazon Pay balance: a radio in the same group when
 * it covers the order, the ppw-APBSelection checkbox when it covers part of it. The widget can reload after
 * a pick and select the balance again, so re-check a few times; paymentPageProblem still refuses to pay if
 * the balance stays selected.
 */
async function selectUpiQr(page: Page, log: (m: string) => void): Promise<void> {
  await page.locator("input[name='ppw-instrumentRowSelection']").first().waitFor({ state: "attached", timeout: 30000 });
  const radios = page.locator(
    "input[name='ppw-instrumentRowSelection'][value*='paymentMethod=UnifiedPaymentsInterface']",
  );
  const balance = page.locator("input[name='ppw-APBSelection'], input[value*='paymentMethod=APB']");
  const box = page.locator("input[type=checkbox][name='ppw-APBSelection']");
  const anyChecked = (l: Locator) => l.evaluateAll((els) => els.some((e) => (e as HTMLInputElement).checked));
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    const labels = await radios.evaluateAll((els) =>
      els.map((e) => {
        let n: HTMLElement | null = e as HTMLElement;
        for (let k = 0; k < 6 && n && (n.innerText ?? "").trim().length < 12; k++) n = n.parentElement;
        return (n?.innerText ?? "").replace(/\s+/g, " ");
      }),
    );
    const idx = labels.findIndex((l) => /scan and pay/i.test(l));
    if (idx < 0)
      throw new BlinkitError(`Amazon didn't offer "Scan and Pay with UPI" for this order (${await snapshot(page)})`);
    if (await anyChecked(box)) {
      log("Turning off Amazon Pay balance on the payment page…");
      await box.first().uncheck({ force: true });
      await sleep(1500);
    }
    await radios.nth(idx).check({ force: true });
    await sleep(3000); // the widget saves the selection (continueWidget) before Pay is safe to press
    if (!(await anyChecked(balance)) && (await radios.nth(idx).isChecked())) return;
    log("Amazon Pay balance is still selected; selecting Scan & Pay UPI again…");
  }
}

/** Read Amazon's QR page: the QR PNG and what /aips/get-status needs. */
async function readQrPage(page: Page) {
  await page.waitForURL(/\/aips\/process-payment/, { timeout: 45000 });
  const img = page.locator("img[src^='data:image/png']").first();
  await img.waitFor({ state: "visible", timeout: 30000 });
  const src = (await img.getAttribute("src")) ?? "";
  const url = new URL(page.url());
  const expiresIn = Number(
    await page
      .locator("input[name=transactionExpiryTimeoutInSec]")
      .getAttribute("value")
      .catch(() => null),
  );
  return {
    png: Buffer.from(src.slice(src.indexOf(",") + 1), "base64"),
    pageUrl: page.url(),
    form: {
      aipsRequestId: url.searchParams.get("idempotencyKey") ?? "",
      clientId: url.searchParams.get("clientId") ?? "",
      callbackUrl: url.searchParams.get("callbackUrl") ?? "",
    },
    purchaseId: url.searchParams.get("purchaseId") ?? undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
  };
}

export async function payNow(deps: NowPayDeps, opts: NowPayOptions): Promise<NowPayStatus> {
  const log = opts.log ?? console.log;
  const mode = opts.handoff ?? "qrbaton";
  deps.session.requireLogin();
  const bill = await deps.checkout();
  const problem = billProblem(bill, opts.confirmAmount);
  if (problem) throw new BlinkitError(problem, { fix: problemFix(problem) });
  const cart = await deps.cart();
  const amount = bill.total;
  const base = { amount, handoff: mode, purchaseId: bill.purchaseId };
  status({ ...base, stage: "launching" });

  let b: NowBrowser | undefined;
  let qr: Awaited<ReturnType<typeof readQrPage>>;
  try {
    b = await openBrowser(deps.session);
    log("Opening Amazon Now checkout…");
    await toPaymentPage(b.page, log);
    await selectUpiQr(b.page, log);
    const pageProblem = paymentPageProblem(await b.page.evaluate(readPaymentPage), amount);
    if (pageProblem) throw new BlinkitError(`${pageProblem} (${await snapshot(b.page)})`);
    if (opts.dryRun) {
      log(`Dry run: Scan & Pay UPI selected for ₹${amount}, balance not used. Stopping before Pay.`);
      return status({ ...base, stage: "dry_run_ok", screenshot: await snapshot(b.page) });
    }
    const label = `Pay ₹${amount.toFixed(2)}`;
    const submit = b.page.locator("input[type=submit][aria-labelledby]").filter({ visible: true });
    const labels = await submit.evaluateAll((els) =>
      els.map((e) => document.getElementById(e.getAttribute("aria-labelledby") ?? "")?.innerText.trim()),
    );
    log(`Placing the order (${label}, Scan & Pay UPI)…`);
    await submit.nth(labels.indexOf(label)).click();
    qr = await readQrPage(b.page);
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    status({ ...base, stage: "error", error, url: b?.page.url() });
    throw e;
  } finally {
    await b?.close();
  }

  // The order exists from here on: never start a second payment, just report.
  const upiIntent = decodeQrPng(qr.png);
  const qrAmount = upiIntent ? upiAmount(upiIntent) : null;
  if (upiIntent && (qrAmount == null || paise(qrAmount) !== paise(amount))) {
    const error = `Amazon's QR is for ₹${qrAmount ?? "?"}, not ₹${amount}; not handing it out`;
    status({ ...base, stage: "error", error, purchaseId: qr.purchaseId ?? bill.purchaseId });
    throw new BlinkitError(error);
  }
  const timeoutMs = (opts.timeoutSec ?? 600) * 1000;
  // The QR's own QRexpire is what the payer's UPI app enforces; the page countdown is the fallback.
  const expiries = [upiIntent ? upiExpiry(upiIntent) : null, qr.expiresAt ?? null].filter(
    (t): t is number => t != null,
  );
  const expiresAt = expiries.length ? Math.min(...expiries) : undefined;
  const deadline = Math.min(Date.now() + timeoutMs, (expiresAt ?? Number.POSITIVE_INFINITY) + 30_000);
  const link: HandoffResult = await handOffOrder(mode, {
    order: nowQrbatonOrder(bill, cart, opts.agent),
    upiIntent,
    qrPng: qr.png,
    ttlSec: Math.max(60, Math.round((Math.min(deadline, expiresAt ?? deadline) - Date.now()) / 1000)),
    qrPath: amazonPaths.qr,
  });
  const ready = {
    ...base,
    handoff: link.handoff,
    purchaseId: qr.purchaseId ?? bill.purchaseId,
    qrImage: link.qrImage,
    ...(upiIntent ? { upiIntent } : {}),
    ...(link.payLink ? { payLink: link.payLink, sessionId: link.sessionId } : {}),
    ...(expiresAt ? { qrExpiresAt: expiresAt } : {}),
    ...(link.warning || !upiIntent
      ? { warning: link.warning ?? "couldn't read the QR's UPI link; the amount inside it wasn't checked" }
      : {}),
  };
  status({ ...ready, stage: "qr_ready" });
  announce(link, amount, ready.warning, opts, log);
  if (expiresAt) log(`QR valid until ${new Date(expiresAt).toLocaleTimeString()}.`);

  const finish = async (stage: PayStage, extra: Partial<NowPayStatus> = {}) => {
    const s = qrbatonStatusFor(stage);
    if (s) await reportStatus(link, s);
    return status({ ...ready, ...extra, stage });
  };
  let last = "";
  while (Date.now() < deadline) {
    await sleep(4000);
    try {
      const r = await deps.session.raw("POST", "/aips/get-status", {
        form: qr.form,
        from: qr.pageUrl,
        headers: { "x-requested-with": "XMLHttpRequest" },
      });
      const reply = JSON.parse(r.text);
      last = String(reply?.status ?? "");
      const outcome: NowPayOutcome | null = payOutcome(reply);
      if (outcome) {
        log(
          outcome === "paid"
            ? "Payment received."
            : `Payment ${outcome === "failed" ? "failed" : "expired"} (${last}).`,
        );
        return finish(outcome, { amazonStatus: last });
      }
    } catch {
      // transient; keep polling until the deadline
    }
  }
  return finish("timeout", { amazonStatus: last || undefined });
}

function announce(
  link: HandoffResult,
  amount: number,
  warning: string | undefined,
  opts: NowPayOptions,
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
