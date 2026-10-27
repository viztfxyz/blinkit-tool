import { join } from "node:path";
import { CACHE_DIR, CONFIG_DIR } from "../../core/config.js";

export const BASE = "https://blinkit.com";

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

/** zpaykit runs on zomato.com, so the pay client picks up a Chrome-TLS session there first. */
export const ZPAYKIT_PROBE = "https://www.zomato.com/";

export const paths = {
  session: process.env.BLINKIT_SESSION ?? join(CONFIG_DIR, "session.json"),
  locations: join(CACHE_DIR, "locations.json"),
  categories: join(CACHE_DIR, "categories.json"),
  payStatus: join(CACHE_DIR, "pay_status.json"),
  qr: join(CACHE_DIR, "upi_qr.png"),
  qrRaw: join(CACHE_DIR, "upi_qr_capture.png"),
  dryRunShot: join(CACHE_DIR, "dry_run_checkout.png"),
  payErrorShot: join(CACHE_DIR, "pay_error.png"),
};

/** Names for cart `additional_charges` ids, as labelled on blinkit.com's bill. */
export const CHARGE_NAMES: Record<number, string> = { 3: "handling_charge", 7: "small_cart_charge" };
