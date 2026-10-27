/**
 * Plain-HTTP side of Zepto. zepto.com sits behind AWS WAF: a real browser solves its challenge once and
 * gets an `aws-waf-token` cookie (about 4 days), after which Chrome-TLS curl (cuimp) can call the API
 * gateway directly, as long as every call carries the web app's headers and request signature.
 *
 * The session is a Netscape cookie file that curl reads and rewrites (Zepto rotates its 1-hour access
 * token through Set-Cookie) and Chromium is seeded from when the WAF token needs renewing.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { type CuimpHttp, createCuimpHttp } from "cuimp";
import { requireBrowser } from "../../core/browser.js";
import { type BrowserCookie, readCookies, writeCookies } from "../../core/cookies.js";
import { HandcartError } from "../../core/errors.js";
import type { Json } from "../../core/types.js";
import {
  ACCESS_COOKIE,
  COMPATIBLE_COMPONENTS,
  REFRESH_COOKIE,
  WAF_COOKIE,
  ZEPTO_API,
  ZEPTO_APP_VERSION,
  ZEPTO_BASE,
  ZEPTO_UA,
  zeptoPaths,
} from "./config.js";
import { signRequest } from "./sign.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
/** Renew the WAF token this long before it expires. */
const WAF_MARGIN_SEC = 600;

export interface ZeptoRequest {
  json?: unknown;
  headers?: Record<string, string>;
}

/** The store serving the selected address; search, cart and order calls name it in headers. */
export interface StoreContext {
  storeId: string;
  storeIds: string[];
  /** storeId → ETA minutes, as the web app sends it. */
  etas: Record<string, number>;
}

export class ZeptoSession {
  private client?: CuimpHttp;
  /** Zepto's analytics session; any fresh UUID is accepted. */
  readonly sessionId = randomUUID();
  store?: StoreContext;

  constructor(readonly cookieFile: string = zeptoPaths.cookies) {}

  cookies(): BrowserCookie[] {
    return readCookies(this.cookieFile);
  }

  private cookie(name: string): string | undefined {
    return this.cookies().find((c) => c.name === name)?.value || undefined;
  }

  saveCookies(cookies: BrowserCookie[]): void {
    writeCookies(
      this.cookieFile,
      cookies.filter((c) => c.domain.endsWith("zepto.com")),
      "Zepto session",
    );
    this.client = undefined;
  }

  get loggedIn(): boolean {
    return Boolean(this.cookie(REFRESH_COOKIE) || this.cookie(ACCESS_COOKIE));
  }

  requireLogin(): void {
    if (!this.loggedIn) throw new HandcartError("not logged in to Zepto; run `handcart zepto login <phone>` first");
  }

  logout(): void {
    // Keep the device and WAF cookies: they aren't the account, and re-minting the WAF token needs a browser.
    this.saveCookies(
      this.cookies().filter((c) => ![ACCESS_COOKIE, REFRESH_COOKIE, "isAuth", "user_id"].includes(c.name)),
    );
  }

  private http(): CuimpHttp {
    // A cookie *file* makes curl read and rewrite it, keeping every rotated cookie.
    this.client ??= createCuimpHttp({
      descriptor: { browser: "chrome", version: "142" },
      cookieJar: this.cookieFile,
      logger: quiet,
    });
    return this.client;
  }

  private wafValid(): boolean {
    const waf = this.cookies().find((c) => c.name === WAF_COOKIE);
    return Boolean(waf?.value) && (waf?.expires ?? 0) > Date.now() / 1000 + WAF_MARGIN_SEC;
  }

  /**
   * Open zepto.com in headless Chromium so AWS WAF issues its token, and merge it into the session (with
   * the device and CSRF cookies the page sets, when the session has none yet). Needs the full Chromium
   * build: the headless shell is refused with 429.
   *
   * The browser starts empty: seeded with the session's cookies, zepto.com loads without a challenge and
   * no token is issued.
   */
  async mintWafToken(): Promise<void> {
    const executablePath = await requireBrowser();
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      timeout: 60000,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const context = await browser.newContext({ locale: "en-IN", userAgent: ZEPTO_UA });
      const page = await context.newPage();
      await page.goto(`${ZEPTO_BASE}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      const ready = async () => {
        const names = new Set((await context.cookies()).map((c) => c.name));
        return names.has(WAF_COOKIE) && names.has("XSRF-TOKEN") && names.has("device_id");
      };
      for (let i = 0; i < 60 && !(await ready()); i++) await page.waitForTimeout(500);
      if (!(await ready())) {
        throw new HandcartError("Zepto's bot check didn't let the browser through; try again in a few minutes");
      }
      const saved = this.cookies().filter((c) => c.name !== WAF_COOKIE);
      const have = new Set(saved.map((c) => c.name));
      const fresh = (await context.cookies()).filter(
        (c) =>
          c.name === WAF_COOKIE || (["device_id", "csrfSecret", "XSRF-TOKEN"].includes(c.name) && !have.has(c.name)),
      );
      this.saveCookies([...saved, ...fresh]);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  async ensureWaf(): Promise<void> {
    if (!this.wafValid()) await this.mintWafToken();
  }

  async raw(method: "GET" | "POST" | "PUT", url: string, opts: ZeptoRequest = {}) {
    const deviceId = this.cookie("device_id") ?? "";
    const xsrf = decodeURIComponent(this.cookie("XSRF-TOKEN") ?? "");
    const requestId = randomUUID();
    const data = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const store = this.store;
    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-IN",
      origin: ZEPTO_BASE,
      referer: `${ZEPTO_BASE}/`,
      platform: "WEB",
      app_sub_platform: "WEB",
      app_version: ZEPTO_APP_VERSION,
      appversion: ZEPTO_APP_VERSION,
      // Auth comes from the accessToken cookie; without this some services (search) answer 401.
      auth_from_cookie: "true",
      auth_revamp_flow: "v2",
      "x-without-bearer": "true",
      tenant: "ZEPTO",
      source: "DIRECT",
      marketplace_type: "SUPER_SAVER",
      compatible_components: COMPATIBLE_COMPONENTS,
      device_id: deviceId,
      deviceid: deviceId,
      session_id: this.sessionId,
      sessionid: this.sessionId,
      request_id: requestId,
      requestid: requestId,
      "x-xsrf-token": xsrf,
      "x-csrf-secret": this.cookie("csrfSecret") ?? "",
      ...(store
        ? {
            store_id: store.storeId,
            storeid: store.storeId,
            store_ids: store.storeIds.join(","),
            store_etas: JSON.stringify(store.etas),
          }
        : {}),
      ...(data !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
      ...signRequest({ method, url, requestId, deviceId, secret: xsrf, body: data }),
    };
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

  /** Renew the 1-hour access token with the refresh token (www.zepto.com sets both cookies again). */
  private async refreshAuth(): Promise<boolean> {
    if (!this.cookie(REFRESH_COOKIE)) return false;
    const r = await this.raw("POST", `${ZEPTO_BASE}/api/auth/refresh-auth`, { json: {} });
    return r.status === 200;
  }

  /**
   * A gateway (or www.zepto.com/api) call: JSON in, JSON out. Renews the WAF token when it's missing or
   * challenged (HTTP 202/429 with no body) and the access token on 401, once each.
   */
  async api(method: "GET" | "POST" | "PUT", path: string, opts: ZeptoRequest = {}): Promise<Json> {
    const url = path.startsWith("http") ? path : `${ZEPTO_API}/${path.replace(/^\//, "")}`;
    await this.ensureWaf();
    let r = await this.raw(method, url, opts);
    if ((r.status === 202 || r.status === 429) && !r.text.trim()) {
      await this.mintWafToken();
      r = await this.raw(method, url, opts);
    }
    if (r.status === 401 && (await this.refreshAuth())) r = await this.raw(method, url, opts);
    const name = new URL(url).pathname;
    if (r.status === 401) {
      throw new HandcartError("Zepto session expired; run `handcart zepto login <phone>` again", {
        status: 401,
        path: name,
      });
    }
    if ((r.status === 202 || r.status === 429) && !r.text.trim()) {
      throw new HandcartError("Zepto's bot check is blocking requests; wait a few minutes and retry", {
        status: r.status,
        path: name,
      });
    }
    let body: Json;
    try {
      body = r.text ? JSON.parse(r.text) : {};
    } catch {
      throw new HandcartError(`Zepto returned a page instead of data for ${name}`, {
        status: r.status,
        body: r.text,
        path: name,
      });
    }
    if (r.status >= 400) {
      const msg = body?.message ?? body?.error?.message ?? body?.errors?.[0]?.message ?? `HTTP ${r.status}`;
      throw new HandcartError(`Zepto ${name} failed: ${msg}`, { status: r.status, body: r.text, path: name });
    }
    return body;
  }
}
