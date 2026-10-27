import { HandcartError } from "../core/errors.js";
import type { Blinkit } from "../platforms/blinkit/client.js";
import type { BlinkitCart } from "../platforms/blinkit/types.js";
import { type HandoffResult, handOff, openUrl, qrbatonStatusFor, reportStatus } from "./handoff.js";
import { type Handoff, type PayStage, type PayStatus, writePayStatus } from "./status.js";

export interface PayOptions {
  /** Must equal the payable total from checkout, or nothing happens. */
  confirmAmount: number;
  timeoutSec?: number;
  /** Stop before generating the QR. */
  dryRun?: boolean;
  /** Force the Playwright blinkit.com walk instead of the HTTP zpaykit path. */
  browser?: boolean;
  /** "qrbaton" (default): a pay page link. "qr": just the UPI QR image. */
  handoff?: Handoff;
  /** Name shown on the qrbaton page as who prepared the order, e.g. "Claude". */
  agent?: string;
  /** Open the pay link (or QR image) locally. Default true; agents pass false and send it on. */
  openPage?: boolean;
  log?: (msg: string) => void;
}

const paise = (n: number) => Math.round(n * 100);

/** Checkout, and refuse unless the payable total is exactly what the user confirmed. */
export async function confirmedCheckout(bk: Blinkit, confirmAmount: number): Promise<BlinkitCart> {
  if (!bk.loggedIn) throw new HandcartError("pay needs login (`handcart blinkit login <phone>`)");
  if (!bk.state.address)
    throw new HandcartError("choose a saved delivery address first (`handcart blinkit address use <label>`)");
  const cart = await bk.cart.checkout();
  const toPay = cart.bill.toPay;
  if (!Number.isFinite(confirmAmount) || paise(confirmAmount) !== paise(toPay)) {
    throw new HandcartError(`amount to pay is ₹${toPay}, not ₹${confirmAmount}; confirm ₹${toPay} to proceed`);
  }
  return cart;
}

/**
 * One payment attempt's status file and handoff, shared by the API and browser paths:
 * `ready` publishes the QR, `finish` records the outcome and closes the pay page.
 */
export class PayRun {
  private meta: Omit<PayStatus, "ts" | "stage">;
  private link?: HandoffResult;
  readonly log: (msg: string) => void;

  constructor(
    private bk: Blinkit,
    private opts: PayOptions,
    readonly amount: number,
    apiError?: string,
  ) {
    this.log = opts.log ?? console.log;
    this.meta = { amount, handoff: opts.handoff ?? "qrbaton", ...(apiError ? { apiError } : {}) };
  }

  /** True once the payer may have the QR: from then on a failure must not start a second payment. */
  get issued(): boolean {
    return !!this.link;
  }

  status(stage: PayStage, extra: Partial<Omit<PayStatus, "ts" | "stage">> = {}): PayStatus {
    return writePayStatus({ ...this.meta, ...extra, stage });
  }

  async ready(input: {
    cart: BlinkitCart;
    upiIntent?: string | null;
    qrPng?: Buffer;
    orderId?: number;
    trackId?: string;
    qrExpiresAt?: number;
  }) {
    const { opts, log } = this;
    const r = await handOff(opts.handoff ?? "qrbaton", {
      ...input,
      address: this.bk.state.address,
      amount: this.amount,
      agent: opts.agent,
      ttlSec: opts.timeoutSec ?? 600,
    });
    this.link = r;
    this.meta = {
      ...this.meta,
      handoff: r.handoff,
      qrImage: r.qrImage,
      ...(r.upiIntent ? { upiIntent: r.upiIntent } : {}),
      ...(r.qrExpiresAt ? { qrExpiresAt: r.qrExpiresAt } : {}),
      ...(r.payLink ? { payLink: r.payLink, sessionId: r.sessionId } : {}),
      ...(r.warning ? { warning: r.warning } : {}),
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.trackId ? { trackId: input.trackId } : {}),
    };
    this.status("qr_ready");
    if (r.warning) log(`warning: ${r.warning}`);
    if (r.qrExpiresAt) log(`QR expires at ${new Date(r.qrExpiresAt).toLocaleTimeString()}`);
    const open = opts.openPage !== false;
    if (r.payLink) {
      if (open) openUrl(r.payLink);
      log(`Pay link${open ? " (opened)" : ""}: ${r.payLink}`);
      log(`UPI QR also saved at ${r.qrImage}`);
      log("Review the order on the page, tap Pay and approve in your UPI app. Waiting…");
    } else {
      if (open) openUrl(r.qrImage);
      log(`UPI QR for ₹${this.amount}${open ? " (opened)" : ""}: ${r.qrImage}`);
      if (r.upiIntent) log(`UPI link: ${r.upiIntent}`);
      log("Scan it with any UPI app (GPay, PhonePe, Paytm…) and approve. Waiting…");
    }
  }

  async finish(stage: PayStage, extra: Partial<Omit<PayStatus, "ts" | "stage">> = {}): Promise<PayStatus> {
    if (stage === "paid") {
      this.bk.state.cart = {};
      this.bk.state.cartId = null;
      this.bk.save();
    }
    const s = qrbatonStatusFor(stage);
    if (s) await reportStatus(this.link, s);
    return this.status(stage, extra);
  }
}
