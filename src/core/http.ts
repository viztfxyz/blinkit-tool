import { type CuimpHttp, createCuimpHttp } from "cuimp";
import { HandcartError } from "./errors.js";

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

export interface TransportOptions {
  /** Origin that relative paths are resolved against, and whose homepage is warmed. */
  base: string;
  /** Chrome builds to impersonate, tried in order. */
  versions: readonly string[];
  /** Homepage a fresh `chromeClient` probes to pick up that site's cookies. */
  probe: string;
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isChallenge = (r: HttpResponse) => r.status === 403 && /<html|<!doctype/i.test(r.text.slice(0, 300));

/**
 * HTTP with a real-Chrome TLS/header fingerprint (curl-impersonate via cuimp), which the Cloudflare in
 * front of a store's site requires. Before any API call it loads the homepage on a Chrome build that
 * passes and keeps that client's cookies; on a Cloudflare challenge it re-warms on the next build.
 */
export class Transport {
  private client?: CuimpHttp;
  private versionIdx = 0;

  constructor(private readonly opts: TransportOptions) {}

  private async send(c: CuimpHttp, method: Method, url: string, headers: Record<string, string>, data?: string) {
    const r = await c.request<string>({ url, method, headers, data, timeout: 25000, extraCurlArgs: ["--compressed"] });
    return { status: r.status, text: r.rawBody.toString("utf8") };
  }

  /** Get a client whose cookie jar holds a passed homepage visit. */
  private async warm(): Promise<CuimpHttp> {
    if (this.client) return this.client;
    const { base, versions } = this.opts;
    for (let i = 0; i < versions.length; i++) {
      const version = versions[this.versionIdx % versions.length];
      const c = createCuimpHttp({ descriptor: { browser: "chrome", version }, cookieJar: true, logger: quiet });
      const home = await this.send(c, "GET", `${base}/`, {}).catch(() => ({ status: 0, text: "" }));
      if (home.status === 200) {
        this.client = c;
        return c;
      }
      this.versionIdx++;
    }
    throw new HandcartError(
      `${new URL(base).host} is refusing automated requests right now (Cloudflare); try again in a few minutes`,
    );
  }

  async request(method: Method, pathOrUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.opts.base + pathOrUrl;
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
      // Absolute URLs (e.g. zomato.com) still use a Chrome-TLS client; warm the store's site once for CF cookies.
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
    const { versions, probe } = this.opts;
    for (let i = 0; i < versions.length; i++) {
      const version = versions[(this.versionIdx + i) % versions.length];
      const c = createCuimpHttp({ descriptor: { browser: "chrome", version }, cookieJar: true, logger: quiet });
      const r = await this.send(c, "GET", probe, {}).catch(() => ({ status: 0, text: "" }));
      if (r.status > 0 && r.status < 500) return c;
    }
    // The probe may 403 its bare homepage; still return a Chrome client — zpaykit often works anyway.
    return createCuimpHttp({
      descriptor: { browser: "chrome", version: versions[this.versionIdx % versions.length] },
      cookieJar: true,
      logger: quiet,
    });
  }

  sendRaw(c: CuimpHttp, method: Method, url: string, headers: Record<string, string>, data?: string) {
    return this.send(c, method, url, headers, data);
  }
}
