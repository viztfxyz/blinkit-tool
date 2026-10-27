import { paths } from "../core/config.js";
import { readJson, writeJson } from "../core/storage.js";

export type PayStage =
  | "starting"
  | "launching"
  | "qr_ready"
  | "paid"
  | "failed"
  | "timeout"
  | "browser_closed"
  | "dry_run_ok"
  | "error";

/** How the payment reaches the payer: a qrbaton pay page (default) or just the UPI QR image. */
export type Handoff = "qrbaton" | "qr";
export const HANDOFFS = ["qrbaton", "qr"] as const satisfies readonly Handoff[];

/** Progress of the last `pay`, written to disk so a detached run (the MCP tool) can be polled. */
export interface PayStatus {
  stage: PayStage;
  ts: number;
  amount?: number;
  handoff?: Handoff;
  /** UPI QR PNG on disk. With handoff "qr", send this image to the payer. */
  qrImage?: string;
  upiIntent?: string;
  /** qrbaton pay page (order summary, UPI app buttons, live status). Send this link to the payer. */
  payLink?: string;
  /** qrbaton session id. */
  sessionId?: string;
  /** Something degraded but the run continued, e.g. qrbaton was unreachable so only the QR is available. */
  warning?: string;
  screenshot?: string;
  url?: string;
  error?: string;
  /** Why the headless zpaykit API failed, when pay fell back to the browser. */
  apiError?: string;
  trackId?: string;
  orderId?: number;
}

/** `file` defaults to Blinkit's status file; Amazon Now keeps its own so the two never mix. */
export function writePayStatus<T extends PayStatus>(s: Omit<T, "ts">, file = paths.payStatus): T {
  const status = { ...s, ts: Date.now() } as T;
  writeJson(file, status);
  return status;
}

export const readPayStatus = <T extends PayStatus = PayStatus>(file = paths.payStatus): T =>
  readJson<T>(file) ?? ({ stage: "starting", ts: 0 } as T);
