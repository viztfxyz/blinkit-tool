import { join } from "node:path";
import { CACHE_DIR, CONFIG_DIR } from "../../core/config.js";

export const ZEPTO_BASE = "https://www.zepto.com";
/** The web app's API gateway; every call there is signed (see sign.ts). */
export const ZEPTO_API = "https://bff-gateway.zepto.com";
/** Product images are paths under this CDN. */
export const ZEPTO_CDN = "https://cdn.zeptonow.com/production/";

/** The web build we present as. The gateway rejects calls without an app version (HTTP 429). */
export const ZEPTO_APP_VERSION = "17.5.3";

/** Matches the Chrome build cuimp impersonates, so the browser and HTTP sides look like one client. */
export const ZEPTO_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/** The AWS WAF cookie the gateway requires; only a real browser can mint it. Lasts about 4 days. */
export const WAF_COOKIE = "aws-waf-token";
/** Zepto's signed-in cookies: a 1-hour JWT and the token that renews it. */
export const ACCESS_COOKIE = "accessToken";
export const REFRESH_COOKIE = "refreshToken";

/** Feature flags the web app announces; cart and search answers depend on them. */
export const COMPATIBLE_COMPONENTS = [
  "EXTERNAL_COUPONS",
  "BUNDLE",
  "MULTI_SELLER_ENABLED",
  "ROLLUPS",
  "SCHEDULED_DELIVERY",
  "NEW_BILL_INFO",
  "SUPERSTORE_V1",
  "ZEPTO_PASS:5",
  "CART_REDESIGN_ENABLED",
  "SHIPMENT_WIDGETIZATION_ENABLED",
  "MANUALLY_APPLIED_DELIVERY_FEE_RECEIVABLE",
  "ITEMISATION_ENABLED",
  "NO_PLATFORM_CHECK_ENABLED_V2",
  "PROMO_CASH:0",
].join(",");

export const zeptoPaths = {
  /** Netscape cookie file shared by curl (HTTP calls) and Chromium (WAF token). Owner-readable only. */
  cookies: process.env.ZEPTO_COOKIES ?? join(CONFIG_DIR, "zepto.cookies"),
  /** Selected address and the cart. Zepto keeps the cart on the client, so this is the cart. */
  state: process.env.ZEPTO_STATE ?? join(CONFIG_DIR, "zepto.json"),
  payStatus: join(CACHE_DIR, "zepto_pay_status.json"),
  qr: join(CACHE_DIR, "zepto_upi_qr.png"),
};
