export interface HandcartErrorInfo {
  status?: number;
  /** Raw HTTP body, so callers can include a snippet in a more specific message. */
  body?: string;
  path?: string;
}

/** Any expected failure: bad input, not logged in, unserviceable area, a platform rejecting a request. */
export class HandcartError extends Error {
  readonly status?: number;
  readonly body?: string;
  readonly path?: string;

  constructor(message: string, info?: HandcartErrorInfo) {
    super(message);
    this.name = "HandcartError";
    this.status = info?.status;
    this.body = info?.body;
    this.path = info?.path;
  }
}
