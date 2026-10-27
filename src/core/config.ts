import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BASE = "https://blinkit.com";

/** package.json sits two levels above src/core/ and dist/core/. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** Public key embedded in blinkit.com's page config; used to mint an anonymous auth key. */
export const REQUEST_KEY = "c0e6868e-1180-400c-be51-f473479f1f0a";

/** Headers the blinkit.com web app sends with every API call. */
export const APP_HEADERS: Record<string, string> = {
  app_client: "consumer_web",
  web_app_version: "1008010016",
  app_version: "52434332",
  rn_bundle_version: "1009003012",
  origin: BASE,
  referer: `${BASE}/`,
};

/**
 * Chrome builds to impersonate (TLS + header fingerprint). Cloudflare lets these load the homepage,
 * and API calls such as /v5/carts only pass with the cookies that visit sets. Tried in order.
 */
export const IMPERSONATE_VERSIONS = ["152", "151", "150", "142"];

const CACHE_DIR = join(homedir(), ".cache", "blinkit-tool");
const CONFIG_DIR = join(homedir(), ".config", "blinkit-tool");

export const paths = {
  session: process.env.BLINKIT_SESSION ?? join(CONFIG_DIR, "session.json"),
  /** Settings found once and reused, such as the browser path. */
  config: process.env.BLINKIT_CONFIG ?? join(CONFIG_DIR, "config.json"),
  locations: join(CACHE_DIR, "locations.json"),
  categories: join(CACHE_DIR, "categories.json"),
  payStatus: join(CACHE_DIR, "pay_status.json"),
  qr: join(CACHE_DIR, "upi_qr.png"),
  qrRaw: join(CACHE_DIR, "upi_qr_capture.png"),
  dryRunShot: join(CACHE_DIR, "dry_run_checkout.png"),
  payErrorShot: join(CACHE_DIR, "pay_error.png"),
};

/** qrbaton (https://qrbaton.vercel.app) turns the UPI intent + cart into a pay page. Override to self-host. */
export const QRBATON_URL = (process.env.QRBATON_URL ?? "https://qrbaton.vercel.app").replace(/\/$/, "");

export const SORTS = ["relevance", "price", "price_desc", "discount"] as const;
export type Sort = (typeof SORTS)[number];

/** Names for cart `additional_charges` ids, as labelled on blinkit.com's bill. */
export const CHARGE_NAMES: Record<number, string> = { 3: "handling_charge", 7: "small_cart_charge" };
