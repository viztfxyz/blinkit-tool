import { fixFor } from "./fixes.js";

export interface BlinkitErrorInfo {
  status?: number;
  /** Raw HTTP body, so callers can include a snippet in a more specific message. */
  body?: string;
  path?: string;
  /** What to do about it, ideally an exact command. Defaults to `fixFor(message)`. */
  fix?: string;
}

/**
 * Any expected failure: bad input, not logged in, unserviceable area, Blinkit rejecting a request.
 * `message` ends with a "Fix: …" line; `reason` and `fix` hold the two parts.
 */
export class BlinkitError extends Error {
  readonly status?: number;
  readonly body?: string;
  readonly path?: string;
  readonly reason: string;
  readonly fix: string;

  constructor(message: string, info?: BlinkitErrorInfo) {
    const fix = info?.fix ?? fixFor(message);
    super(`${message}\nFix: ${fix}`);
    this.name = "BlinkitError";
    this.reason = message;
    this.fix = fix;
    this.status = info?.status;
    this.body = info?.body;
    this.path = info?.path;
  }
}
