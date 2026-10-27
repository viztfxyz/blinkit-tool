/**
 * UPI payment via Blinkit → Zomato zpaykit over plain HTTPS (Chrome-TLS impersonation):
 *   1. GET  /createOrder/{cart_id}               → PAS token + orderHash
 *   2. POST /zomato_payment_hash                 → payment_hash + numeric order_id
 *   3. POST zomato.com/zpaykit/getPaymentMethods → laravel_session cookie
 *   4. POST zomato.com/zpaykit/makePayment       → upi://pay?… intent (QR payload) + its expiry
 *   5. poll zpaykit/verifyPaymentStatus
 */
import type { CuimpHttp } from "cuimp";
import { HandcartError } from "../core/errors.js";
import type { Blinkit } from "../platforms/blinkit/client.js";
import type { Json } from "../platforms/blinkit/types.js";
import { confirmedCheckout, type PayOptions, PayRun } from "./flow.js";
import type { PayStatus } from "./status.js";

const ZBASE = "https://www.zomato.com/zpaykit";
const SNIPPET = 200;

export interface PreparedOrder {
  cartId: string;
  pasToken: string;
  orderHash: string;
  orderId: number;
  payable: number;
  paymentHash: string;
}

export function prepareFailureMessage(call: string, status: number, body?: string, message?: string): string {
  const snippet = (body ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET);
  const fallback = message && !/^HTTP \d+$/.test(message) ? message : "";
  const tail = snippet || fallback;
  return tail ? `${call} failed (HTTP ${status}): ${tail}` : `${call} failed (HTTP ${status})`;
}

function rewritePrepareError(call: string, error: unknown): Error {
  if (error instanceof HandcartError && error.status != null && error.status >= 400) {
    return new HandcartError(prepareFailureMessage(call, error.status, error.body, error.message));
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function prepareCall(
  bk: Blinkit,
  method: "GET" | "POST",
  path: string,
  opts: Parameters<Blinkit["req"]>[2],
): Promise<Json> {
  try {
    return await bk.req(method, path, opts);
  } catch (error) {
    throw rewritePrepareError(`${method} ${path}`, error);
  }
}

export async function prepareOrder(bk: Blinkit, cartId: string): Promise<PreparedOrder> {
  const co = await prepareCall(bk, "GET", `/createOrder/${cartId}`, { needLogin: true });
  const pasToken = co?.response?.access_token as string | undefined;
  if (!pasToken) {
    throw new HandcartError(
      "createOrder returned no PAS token — the cart may already have a pending payment. " +
        "Clear the pending txn (or wait for it to expire), then retry.",
    );
  }
  const ph = await prepareCall(bk, "POST", "/zomato_payment_hash", {
    needLogin: true,
    json: { cart_id: String(cartId), payment_info_data: { payment_method_id: 50, payment_method_type: "upi_qr" } },
  });
  const meta = ph?.zomato_payment_hash_meta;
  if (!meta?.payment_hash || !meta?.order_id) {
    throw new HandcartError(`zomato_payment_hash failed: ${JSON.stringify(ph).slice(0, SNIPPET)}`);
  }
  return {
    cartId: String(cartId),
    pasToken,
    orderHash: (co?.orderHash as string | undefined) ?? "",
    orderId: Number(meta.order_id),
    payable: Number(meta.payable_amount),
    paymentHash: String(meta.payment_hash),
  };
}

export function commonForm(o: PreparedOrder, phone: string): Record<string, string> {
  return {
    service_type: "BLINKIT",
    country_id: "1",
    order_type: "null",
    order_id: String(o.orderId),
    amount: String(o.payable),
    payments_hash: o.paymentHash,
    host_redirect_url: `https://blinkit.com/zpay/${o.orderId}`,
    phone,
    email: `${phone}@blinkit.com`,
    promo_code: "",
    locale: "en",
    gateway_info: "null",
    online_payments_flag: "1",
    isMobileView: "false",
    additional_params: JSON.stringify({
      block_payment_methods: [],
      eligible_bank_codes: null,
      emi_details: null,
      hidden_payment_methods: [],
      service_type: "BLINKIT",
      show_warning_banner: 1,
      user_details: { addressDetails: null },
    }),
  };
}

export type PaymentState = "paid" | "failed" | "pending";

const PAID = new Set(["success", "successful", "paid", "completed", "captured"]);
const FAILED = new Set(["failed", "failure", "cancelled", "canceled", "declined", "expired"]);

/**
 * zpaykit's verdict on a payment, read only from verifyPaymentStatus's `response.status`.
 * Anything else (an error reply such as `{"status":400,"details":"Invalid track_id"}`, a network
 * failure, a state we don't know) counts as pending: only an explicit answer may end the wait.
 */
export function paymentState(reply: Json): PaymentState {
  const st = String(reply?.response?.status ?? "").toLowerCase();
  if (PAID.has(st)) return "paid";
  if (FAILED.has(st)) return "failed";
  return "pending";
}

/** Seconds until the next status check: zpaykit's `poll_interval` (it asks for 10), within 3–30. */
export function pollDelaySec(reply: Json): number {
  const s = Number(reply?.response?.poll_interval);
  return Number.isFinite(s) && s > 0 ? Math.min(30, Math.max(3, s)) : 5;
}

/**
 * When the QR stops accepting payment, as epoch ms: makePayment's `qr_data.expiry_time` (unix
 * seconds; 5 minutes after creation as of 2026-10-27). Undefined when absent or not a number.
 */
export function qrExpiresAt(txn: Json): number | undefined {
  const s = Number(txn?.qr_data?.expiry_time);
  return Number.isFinite(s) && s > 0 ? s * 1000 : undefined;
}

/** The status check identifies the payment by makePayment's track_id; without it zpaykit replies 400. */
export function verifyForm(o: PreparedOrder, phone: string, trackId: string): Record<string, string> {
  return { ...commonForm(o, phone), track_id: trackId };
}

export async function zpost(
  bk: Blinkit,
  client: CuimpHttp,
  path: string,
  pasToken: string,
  form: Record<string, string>,
): Promise<Json> {
  const r = await bk.http.sendRaw(
    client,
    "POST",
    `${ZBASE}/${path}`,
    {
      "x-client-pas-token": pasToken,
      "content-type": "application/x-www-form-urlencoded",
      locale: "en",
      referer: "https://www.zomato.com/zpaykit/init",
      origin: "https://www.zomato.com",
    },
    new URLSearchParams(form).toString(),
  );
  try {
    return JSON.parse(r.text);
  } catch {
    return { status: r.status, raw: r.text.slice(0, 300) };
  }
}

/**
 * Headless UPI. `progress.run` is set once an order is being prepared (so a browser retry makes
 * sense), and `progress.run.issued` once the payer may already have the QR (so it doesn't).
 */
export async function payViaApi(bk: Blinkit, opts: PayOptions, progress: { run?: PayRun }): Promise<PayStatus> {
  const cart = await confirmedCheckout(bk, opts.confirmAmount);
  const phone = bk.state.user?.phone;
  if (!phone)
    throw new HandcartError("session has no phone number; log in again with `handcart blinkit login <phone>`");
  const cartId = bk.state.cartId ?? cart.cartId;
  if (!cartId) throw new HandcartError("no server cart id; run `handcart blinkit checkout` first");
  const toPay = cart.bill.toPay;

  const run = new PayRun(bk, opts, toPay);
  progress.run = run;
  run.status("launching");
  run.log(`Preparing order for cart ${cartId}…`);
  const prepared = await prepareOrder(bk, String(cartId));
  if (Math.round(prepared.payable * 100) !== Math.round(toPay * 100)) {
    throw new HandcartError(`payment hash amount is ₹${prepared.payable} but checkout showed ₹${toPay}; aborting`);
  }

  const client = await bk.http.chromeClient();
  run.log("Opening UPI payment session…");
  await zpost(bk, client, "getPaymentMethods", prepared.pasToken, commonForm(prepared, phone));
  if (opts.dryRun) {
    run.log(`Dry run: payment session ready for ₹${toPay} (order ${prepared.orderId}).`);
    return run.status("dry_run_ok", { orderId: prepared.orderId });
  }

  // The web app literally sends the string "[object Object]" for payments_config_params; omitting it fails.
  const mp = await zpost(bk, client, "makePayment", prepared.pasToken, {
    ...commonForm(prepared, phone),
    payment_method_id: "50",
    payment_method_type: "upi_qr",
    payments_config_params: "[object Object]",
  });
  const txn = mp?.response?.transaction;
  const upiIntent = txn?.qr_data?.data as string | undefined;
  const trackId = txn?.track_id as string | undefined;
  if (!upiIntent?.startsWith("upi:") || !trackId) {
    const status = String(txn?.status ?? mp?.response?.status ?? "unknown");
    throw new HandcartError(
      `makePayment did not return a UPI intent and track_id (status=${status}): ${JSON.stringify(mp).slice(0, 240)}`,
    );
  }

  await run.ready({ cart, upiIntent, orderId: prepared.orderId, trackId, qrExpiresAt: qrExpiresAt(txn) });
  const form = verifyForm(prepared, phone, trackId);
  const deadline = Date.now() + (opts.timeoutSec ?? 600) * 1000;
  while (Date.now() < deadline) {
    const reply = await zpost(bk, client, "verifyPaymentStatus", prepared.pasToken, form).catch(() => undefined);
    const state = paymentState(reply);
    if (state === "paid") return run.finish("paid");
    if (state === "failed") {
      const why = reply?.response?.message ? String(reply.response.message) : undefined;
      return run.finish("failed", why ? { error: why } : {});
    }
    await new Promise((res) => setTimeout(res, pollDelaySec(reply) * 1000));
  }
  return run.finish("timeout");
}
