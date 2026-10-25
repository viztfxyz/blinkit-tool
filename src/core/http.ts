import { type CuimpHttp, createCuimpHttp } from "cuimp";
import { BASE, IMPERSONATE_VERSIONS } from "./config.js";
import { BlinkitError } from "./errors.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpResponse {
  status: number;
  text: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isChallenge = (r: HttpResponse) => r.status === 403 && /<html|<!doctype/i.test(r.text.slice(0, 300));

/**
 * HTTP with a real-Chrome TLS/header fingerprint (curl-impersonate via cuimp), which Cloudflare in
 * front of blinkit.com requires. Before any API call it loads the homepage on a Chrome build that
 * passes and keeps that client's cookies; on a Cloudflare challenge it re-warms on the next build.
 */
export class Transport {
  private client?: CuimpHttp;
  private versionIdx = 0;

  private async send(c: CuimpHttp, method: Method, url: string, headers: Record<string, string>, data?: string) {
    const r = await c.request<string>({ url, method, headers, data, timeout: 25000, extraCurlArgs: ["--compressed"] });
    return { status: r.status, text: r.rawBody.toString("utf8") };
  }

  /** Get a client whose cookie jar holds a passed homepage visit. */
  private async warm(): Promise<CuimpHttp> {
    if (this.client) return this.client;
    for (let i = 0; i < IMPERSONATE_VERSIONS.length; i++) {
      const version = IMPERSONATE_VERSIONS[this.versionIdx % IMPERSONATE_VERSIONS.length];
      const c = createCuimpHttp({ descriptor: { browser: "chrome", version }, cookieJar: true, logger: quiet });
      const home = await this.send(c, "GET", `${BASE}/`, {}).catch(() => ({ status: 0, text: "" }));
      if (home.status === 200) {
        this.client = c;
        return c;
      }
      this.versionIdx++;
    }
    throw new BlinkitError(
      "blinkit.com is refusing automated requests right now (Cloudflare); try again in a few minutes",
    );
  }

  async request(method: Method, pathOrUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : BASE + pathOrUrl;
    const headers: Record<string, string> = { ...opts.headers };
    let data: string | undefined;
    if (opts.json !== undefined) {
      data = JSON.stringify(opts.json);
      headers["content-type"] ??= "application/json";
    } else if (opts.form) {
      data = new URLSearchParams(opts.form).toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    let res: HttpResponse = { status: 0, text: "" };
    for (let attempt = 0; attempt < 4; attempt++) {
      // Absolute URLs (e.g. zomato.com) still use a Chrome-TLS client; warm blinkit.com once for CF cookies.
      res = await this.send(await this.warm(), method, url, headers, data);
      if (isChallenge(res)) {
        this.client = undefined; // re-warm on the next Chrome build
        this.versionIdx++;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      return res;
    }
    return res;
  }

  /** Fresh Chrome-TLS client with its own cookie jar (needed for zpaykit laravel_session). */
  async chromeClient(): Promise<CuimpHttp> {
    for (let i = 0; i < IMPERSONATE_VERSIONS.length; i++) {
      const version = IMPERSONATE_VERSIONS[(this.versionIdx + i) % IMPERSONATE_VERSIONS.length];
      const c = createCuimpHttp({ descriptor: { browser: "chrome", version }, cookieJar: true, logger: quiet });
      const probe = await this.send(c, "GET", "https://www.zomato.com/", {}).catch(() => ({ status: 0, text: "" }));
      if (probe.status > 0 && probe.status < 500) return c;
    }
    // Zomato may 403 the bare homepage; still return a Chrome client — zpaykit often works anyway.
    return createCuimpHttp({
      descriptor: { browser: "chrome", version: IMPERSONATE_VERSIONS[this.versionIdx % IMPERSONATE_VERSIONS.length] },
      cookieJar: true,
      logger: quiet,
    });
  }

  sendRaw(c: CuimpHttp, method: Method, url: string, headers: Record<string, string>, data?: string) {
    return this.send(c, method, url, headers, data);
  }
}
