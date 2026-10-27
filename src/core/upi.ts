/** Reading a `upi://pay` intent, whichever store's QR it came out of. */

/** The amount (rupees) inside a upi://pay intent, or null when it has none. */
export function upiAmount(intent: string): number | null {
  const am = new URL(intent.replace(/^upi:\/\//i, "https://upi/")).searchParams.get("am");
  const n = am == null ? Number.NaN : Number(am);
  return Number.isFinite(n) ? n : null;
}

/**
 * When the QR itself stops accepting payment, from its `QRexpire` parameter (ISO time with up to
 * 9 fraction digits, e.g. 2026-10-27T12:53:46.04695114+05:30). This is what the payer's UPI app
 * enforces, so it wins over the payment page's countdown. Epoch ms, or null when absent.
 */
export function upiExpiry(intent: string): number | null {
  // Not URLSearchParams: it would turn the raw "+" of "+05:30" into a space.
  const m = intent.match(/[?&]QRexpire=([^&]+)/);
  if (!m) return null;
  const raw = decodeURIComponent(m[1]);
  const t = Date.parse(raw.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(t) ? t : null;
}
