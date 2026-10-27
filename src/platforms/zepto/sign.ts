import { createHash } from "node:crypto";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface SignInput {
  method: string;
  /** Full URL or path; only path + query are signed. */
  url: string;
  requestId: string;
  deviceId: string;
  /** The x-xsrf-token header ("" when there is none). */
  secret: string;
  /** The exact body string sent; undefined for GET. */
  body?: string;
}

/**
 * Zepto's `request-signature` and `x-timezone` headers, as the web app computes them: SHA-256 of the
 * values of {body, deviceId, method, requestId, secret, url} in key order joined by "|" (an absent body
 * is the literal "undefined"), and SHA-256 of that. Without them the gateway answers 429.
 */
export function signRequest(r: SignInput): { "request-signature": string; "x-timezone": string } {
  const u = new URL(r.url, "https://bff-gateway.zepto.com");
  const query = u.searchParams.toString();
  const method = r.method.toLowerCase();
  const fields: Record<string, string | undefined> = {
    body: method === "get" ? undefined : r.body,
    deviceId: r.deviceId,
    method,
    requestId: r.requestId,
    secret: r.secret,
    url: u.pathname + (query ? `?${query}` : ""),
  };
  const signature = sha256(
    Object.keys(fields)
      .sort()
      .map((k) => String(fields[k]))
      .join("|"),
  );
  return { "request-signature": signature, "x-timezone": sha256(signature) };
}
