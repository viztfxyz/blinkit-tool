import { randomUUID } from "node:crypto";
import type { Coords, Json, Location, SessionState } from "../types.js";
import { APP_HEADERS, paths, REQUEST_KEY } from "./config.js";
import { BlinkitError } from "./errors.js";
import { type Method, Transport } from "./http.js";
import { readJson, writeJson } from "./storage.js";

export interface ReqOptions {
  /** Location to price against; defaults to the session's address/area. */
  loc?: Coords;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /** Send auth_key/access_token (default true). */
  auth?: boolean;
  needLogin?: boolean;
}

/** Shared plumbing: the persisted session, the Blinkit auth key, JSON requests and location. */
export class Core {
  readonly http = new Transport();
  state: SessionState;

  constructor(readonly sessionFile: string = paths.session) {
    this.state = { deviceId: randomUUID(), cart: {}, ...readJson<Partial<SessionState>>(sessionFile) };
  }

  save(): void {
    writeJson(this.sessionFile, this.state, true);
  }

  get loggedIn(): boolean {
    return !!this.state.accessToken;
  }

  currentLocation(): Coords | undefined {
    return this.state.address ?? this.state.location;
  }

  private async authKey(refresh = false): Promise<string> {
    const { authKey, authKeyTs = 0 } = this.state;
    if (authKey && !refresh && Date.now() - authKeyTs < 12 * 86400_000) return authKey;
    const r = await this.raw("GET", "/v2/accounts/auth_key/", { auth: false, headers: { req_key: REQUEST_KEY } });
    const key = JSON.parse(r.text).auth_key;
    if (!key) throw new BlinkitError("could not obtain auth key");
    this.state.authKey = key;
    this.state.authKeyTs = Date.now();
    this.save();
    return key;
  }

  async raw(method: Method, path: string, opts: ReqOptions = {}) {
    const headers: Record<string, string> = { ...APP_HEADERS, device_id: this.state.deviceId };
    if (opts.auth !== false) {
      headers.auth_key = await this.authKey();
      if (this.state.accessToken) headers.access_token = this.state.accessToken;
    }
    const loc = opts.loc ?? this.currentLocation();
    if (loc) {
      headers.lat = String(loc.lat);
      headers.lon = String(loc.lon);
    }
    // /createOrder and payment steps require gr_1_* cookies, not just headers.
    const cookies = [`gr_1_deviceId=${this.state.deviceId}`];
    if (this.state.accessToken) cookies.push(`gr_1_accessToken=${encodeURIComponent(this.state.accessToken)}`);
    if (loc) {
      cookies.push(`gr_1_lat=${loc.lat}`, `gr_1_lon=${loc.lon}`);
      if (this.state.address?.label) cookies.push(`gr_1_locality=${encodeURIComponent(this.state.address.label)}`);
    }
    headers.cookie = cookies.join("; ");
    Object.assign(headers, opts.headers);
    return this.http.request(method, path, { headers, json: opts.json, form: opts.form });
  }

  /** JSON request with Blinkit error handling (expired auth key, logged-out session, API errors). */
  async req(method: Method, path: string, opts: ReqOptions = {}): Promise<Json> {
    if (opts.needLogin && !this.loggedIn) throw new BlinkitError("not logged in; run `blinkit login <phone>` first");
    let r = await this.raw(method, path, opts);
    if (r.status === 403 && opts.auth !== false && r.text.trimStart().startsWith("{")) {
      await this.authKey(true);
      r = await this.raw(method, path, opts);
    }
    let data: Json;
    try {
      data = JSON.parse(r.text);
    } catch {
      throw new BlinkitError(`HTTP ${r.status} from ${path} (non-JSON; possibly blocked by Cloudflare)`, {
        status: r.status,
        body: r.text,
        path,
      });
    }
    if (r.status === 401) {
      if (this.state.accessToken) {
        delete this.state.accessToken;
        this.save();
      }
      throw new BlinkitError("session expired or not logged in; run `blinkit login <phone>`", {
        status: r.status,
        body: r.text,
        path,
      });
    }
    if (r.status >= 400) {
      throw new BlinkitError(data?.error || data?.message || `HTTP ${r.status}`, {
        status: r.status,
        body: r.text,
        path,
      });
    }
    return data;
  }

  // ---------- location ----------

  /** Resolve a 6-digit pincode to the coordinates Blinkit uses (cached on disk). */
  async locate(pincode: string): Promise<Location> {
    pincode = String(pincode).trim();
    if (!/^\d{6}$/.test(pincode)) throw new BlinkitError("pincode must be 6 digits");
    const cache = readJson<Record<string, Location>>(paths.locations) ?? {};
    if (cache[pincode]) return cache[pincode];
    const preds: Json[] =
      (await this.req("GET", `/mapAPI/autosuggest_google?query=${pincode}`, { auth: false })).predictions ?? [];
    if (!preds.length) throw new BlinkitError(`no location found for pincode ${pincode}; pass lat/lon instead`);
    const pred = preds.find((p) => p.types?.includes("postal_code")) ?? preds[0];
    const info = await this.req("GET", `/location/info?place_id=${pred.place_id}`, { auth: false });
    if (info.coordinate?.lat == null) throw new BlinkitError(`could not resolve coordinates for ${pincode}`);
    const loc: Location = {
      pincode,
      lat: info.coordinate.lat,
      lon: info.coordinate.lon,
      address: info.display_address?.address_line ?? pred.description,
      city: info.city,
      serviceable: !!info.is_serviceable,
    };
    cache[pincode] = loc;
    writeJson(paths.locations, cache);
    return loc;
  }

  /** Explicit lat/lon, else a pincode, else the session's address/area. */
  async resolveLocation(where: { pincode?: string; lat?: number; lon?: number } = {}): Promise<Location> {
    if (where.lat != null && where.lon != null) return { lat: where.lat, lon: where.lon };
    if (where.pincode) return this.locate(where.pincode);
    const loc = this.currentLocation();
    if (!loc)
      throw new BlinkitError("no location: pass a pincode or lat/lon, or set one with `location` / `address use`");
    return loc;
  }

  /** Browse/cart in an area without login (indicative prices). Clears any selected saved address. */
  async setLocation(where: { pincode?: string; lat?: number; lon?: number }): Promise<Location> {
    const loc = await this.resolveLocation(where);
    this.state.location = loc;
    delete this.state.address;
    this.save();
    return loc;
  }
}
