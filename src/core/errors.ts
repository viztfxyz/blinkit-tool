export interface BlinkitErrorInfo {
  status?: number;
  /** Raw HTTP body, so callers can include a snippet in a more specific message. */
  body?: string;
  path?: string;
}

/** Any expected failure: bad input, not logged in, unserviceable area, Blinkit rejecting a request. */
export class BlinkitError extends Error {
  readonly status?: number;
  readonly body?: string;
  readonly path?: string;

  constructor(message: string, info?: BlinkitErrorInfo) {
    super(message);
    this.name = "BlinkitError";
    this.status = info?.status;
    this.body = info?.body;
    this.path = info?.path;
  }
}
