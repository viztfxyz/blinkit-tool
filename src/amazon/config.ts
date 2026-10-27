import { homedir } from "node:os";
import { join } from "node:path";

export const AMAZON_BASE = "https://www.amazon.in";

/**
 * Amazon Now's store id on amazon.in (the web app lives under /tez, Hindi for "fast"). Not to be
 * confused with `almBrandId=ctnow` / `i=nowstore`, which are Amazon Fresh and the old Prime Now.
 */
export const NOW_BRAND = "qqfsWw9RkO";

export const NOW_HOME = `${AMAZON_BASE}/tez/browse/home?qcbrand=${NOW_BRAND}`;
export const NOW_CART = `${AMAZON_BASE}/tez/browse/cart?qcbrand=${NOW_BRAND}`;

/** Sign-in that returns to Amazon Now (the same OpenID request the web app redirects to). */
export const NOW_SIGNIN =
  `${AMAZON_BASE}/ap/signin?openid.pape.max_auth_age=3600` +
  `&openid.return_to=${encodeURIComponent(NOW_HOME)}` +
  "&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select" +
  "&openid.assoc_handle=amzn_tez_discovery_in&openid.mode=checkid_setup&language=en_IN" +
  "&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select" +
  "&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0";

/** Amazon India's signed-in cookie; only present after a completed login. */
export const AUTH_COOKIE = "at-acbin";

/** Matches the Chrome build cuimp impersonates, so the browser and HTTP sides look like one client. */
export const AMAZON_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const CACHE_DIR = join(homedir(), ".cache", "blinkit-tool");
const CONFIG_DIR = join(homedir(), ".config", "blinkit-tool");

export const amazonPaths = {
  /** Netscape cookie file shared by curl (HTTP calls) and Chromium (login, pay). Owner-readable only. */
  cookies: process.env.AMAZON_NOW_COOKIES ?? join(CONFIG_DIR, "amazon-now.cookies"),
  payStatus: join(CACHE_DIR, "amazon_now_pay_status.json"),
  qr: join(CACHE_DIR, "amazon_now_upi_qr.png"),
  /** Screenshot of the page when login or pay stops somewhere unexpected. */
  screenshot: join(CACHE_DIR, "amazon_now_page.png"),
};
