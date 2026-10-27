/**
 * Pay by UPI. The headless zpaykit API (zpaykit.ts) is the default; if it fails before a QR is
 * issued, or with `browser: true`, blinkit.com is driven in Chromium instead (browser.ts). Either
 * way the QR is handed off as a qrbaton pay link or a plain QR image (handoff.ts).
 */
import type { Blinkit } from "../platforms/blinkit/client.js";
import { payViaBrowser } from "./browser.js";
import type { PayOptions, PayRun } from "./flow.js";
import { type PayStatus, readPayStatus, writePayStatus } from "./status.js";
import { payViaApi } from "./zpaykit.js";

export async function payWithUpi(bk: Blinkit, opts: PayOptions): Promise<PayStatus> {
  if (opts.browser) return payViaBrowser(bk, opts);
  const progress: { run?: PayRun } = {};
  try {
    return await payViaApi(bk, opts, progress);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    // Checks before an order exists (login, address, confirmed amount) would fail the same way in the browser.
    if (!progress.run) throw e;
    // The payer may already have this QR: a second payment attempt could charge twice.
    if (progress.run.issued) {
      await progress.run.finish("error", { error: msg });
      throw e;
    }
    (opts.log ?? console.log)(`API pay failed (${msg}); falling back to browser…`);
    writePayStatus({ stage: "launching", amount: readPayStatus().amount, apiError: msg });
    return payViaBrowser(bk, opts, msg);
  }
}

export type { PayOptions } from "./flow.js";
export { type QrbatonOrder, qrbatonOrder } from "./handoff.js";
export { HANDOFFS, type Handoff, type PayStage, type PayStatus, readPayStatus, writePayStatus } from "./status.js";
