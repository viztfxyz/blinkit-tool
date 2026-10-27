import { chmodSync, existsSync } from "node:fs";
import { type CuimpHttp, createCuimpHttp } from "cuimp";
import { BlinkitError } from "../core/errors.js";
import type { Json } from "../types.js";
import { AMAZON_BASE, AUTH_COOKIE, amazonPaths, NOW_BRAND, NOW_CART } from "./config.js";
import { type BrowserCookie, readCookies, writeCookies } from "./cookies.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

export interface NowRequest {
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /** Page the call appears to come from (referer / return-to-url). */
  from?: string;
}

/** Plain-HTTP side of Amazon Now: Chrome-TLS curl on the shared cookie file, plus the web app's headers. */
export class NowSession {
  private client?: CuimpHttp;
  private csrf?: string;
  private groupId?: string;

  constructor(readonly cookieFile: string = amazonPaths.cookies) {}

  cookies(): BrowserCookie[] {
    return readCookies(this.cookieFile);
  }

  saveCookies(cookies: BrowserCookie[]): void {
    writeCookies(
      this.cookieFile,
      cookies.filter((c) => c.domain.endsWith("amazon.in")),
    );
    this.client = undefined;
    this.csrf = undefined;
  }

  get loggedIn(): boolean {
    return this.cookies().some((c) => c.name === AUTH_COOKIE && c.value);
  }

  requireLogin(): void {
    if (!this.loggedIn) throw new BlinkitError("not logged in to Amazon; run `blinkit amazon login <phone>` first");
  }

  logout(): void {
    this.saveCookies([]);
  }

  private http(): CuimpHttp {
    // A cookie *file* (not `true`) makes curl read and rewrite it, keeping every rotated cookie.
    this.client ??= createCuimpHttp({
      descriptor: { browser: "chrome", version: "142" },
      cookieJar: this.cookieFile,
      logger: quiet,
    });
    return this.client;
  }

  async raw(method: "GET" | "POST", path: string, opts: NowRequest = {}) {
    const from = opts.from ?? NOW_CART;
    const headers: Record<string, string> = {
      "accept-language": "en-IN,en;q=0.9",
      origin: AMAZON_BASE,
      referer: from,
      ...opts.headers,
    };
    let data: string | undefined;
    if (opts.json !== undefined) {
      data = JSON.stringify(opts.json);
      headers["content-type"] = "application/json";
    } else if (opts.form) {
      data = new URLSearchParams(opts.form).toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const url = path.startsWith("http") ? path : AMAZON_BASE + path;
    const r = await this.http().request<string>({
      url,
      method,
      headers,
      data,
      timeout: 25000,
      extraCurlArgs: ["--compressed"],
    });
    if (existsSync(this.cookieFile)) chmodSync(this.cookieFile, 0o600); // curl rewrites it with default perms
    return { status: r.status, text: r.rawBody.toString("utf8") };
  }

  /** CSRF token the web app sends as `anti-csrftoken-a2z` on every /tez POST. */
  private async csrfToken(refresh = false): Promise<string> {
    if (this.csrf && !refresh) return this.csrf;
    const r = await this.raw("GET", "/tez/browse/csrf");
    const token = parse(r.text, "/tez/browse/csrf")?.data?.CSRFToken;
    if (!token) throw new BlinkitError("Amazon did not issue a CSRF token; try again");
    this.csrf = token;
    return token;
  }

  /** Forget the cached store group: a different address may be served by a different store. */
  resetStore(): void {
    this.groupId = undefined;
  }

  /** The store group the session is served from; search and cart calls send it as `tez-group-id`. */
  private async storeGroup(): Promise<string> {
    if (this.groupId) return this.groupId;
    const r = await this.raw("GET", `/tez/browse/storefront?brandId=${NOW_BRAND}&offset=0`);
    this.groupId = parse(r.text, "/tez/browse/storefront")?.data?.metadata?.stores?.[0]?.groupId ?? "";
    return this.groupId ?? "";
  }

  /** A /tez API call: JSON in, `{success, statusCode, data}` out. Throws BlinkitError on failure. */
  async api(method: "GET" | "POST", path: string, opts: NowRequest = {}): Promise<Json> {
    const call = async (refresh: boolean) =>
      this.raw(method, path, {
        ...opts,
        headers: {
          "anti-csrftoken-a2z": await this.csrfToken(refresh),
          "tez-brand-id": NOW_BRAND,
          "tez-group-id": await this.storeGroup(),
          "return-to-url": new URL(opts.from ?? NOW_CART).pathname + new URL(opts.from ?? NOW_CART).search,
          ...opts.headers,
        },
      });
    let r = await call(false);
    if (r.status === 403) r = await call(true); // expired CSRF token
    const body = parse(r.text, path);
    if (r.status === 401 || body?.statusCode === "401") {
      throw new BlinkitError("Amazon session expired; run `blinkit amazon login <phone>` again", {
        status: r.status,
        path,
      });
    }
    if (r.status === 429 || body?.statusCode === "429") {
      throw new BlinkitError("Amazon is rate-limiting requests; wait a minute and retry", { status: 429, path });
    }
    if (r.status >= 400 || body?.success === false) {
      throw new BlinkitError(`Amazon ${path.split("?")[0]} failed: ${body?.message ?? `HTTP ${r.status}`}`, {
        status: r.status,
        body: r.text,
        path,
      });
    }
    return body;
  }
}

function parse(text: string, path: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    throw new BlinkitError(
      `Amazon returned a page instead of data for ${path.split("?")[0]} (blocked or logged out?)`,
      {
        body: text,
        path,
      },
    );
  }
}
