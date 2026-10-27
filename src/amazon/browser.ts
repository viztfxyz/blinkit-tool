/**
 * Chromium for the two steps Amazon only allows in a real page: login (passkey / OTP screens) and
 * payment (the payments portal's widget state). Runs headless by default, so it works on a server.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { requireBrowser } from "../core/browser.js";
import { AMAZON_UA, amazonPaths } from "./config.js";
import type { NowSession } from "./session.js";

export interface NowBrowser {
  page: Page;
  context: BrowserContext;
  /** Save the browser's cookies to the session file, then close. Safe to call twice. */
  close(): Promise<void>;
  /** Close without saving: for abandoned logins, which must not replace a working session. */
  discard(): Promise<void>;
}

/** `fresh`: start without the saved cookies (a new login). */
export async function openBrowser(
  session: NowSession,
  opts: { headed?: boolean; fresh?: boolean } = {},
): Promise<NowBrowser> {
  const executablePath = await requireBrowser();
  const { chromium } = await import("playwright-core");
  const browser: Browser = await chromium.launch({ executablePath, headless: !opts.headed, timeout: 60000 });
  const context = await browser.newContext({
    locale: "en-IN",
    userAgent: AMAZON_UA,
    viewport: { width: 1280, height: 1000 },
  });
  const seed = opts.fresh ? [] : session.cookies();
  if (seed.length) await context.addCookies(seed);
  const page = await context.newPage();
  let closed = false;
  return {
    page,
    context,
    async close() {
      if (closed) return;
      closed = true;
      try {
        session.saveCookies(await context.cookies());
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
    async discard() {
      closed = true;
      await browser.close().catch(() => undefined);
    },
  };
}

/** Screenshot for "Amazon showed something unexpected" errors. Returns the path, or undefined. */
export async function snapshot(page: Page): Promise<string | undefined> {
  try {
    mkdirSync(dirname(amazonPaths.screenshot), { recursive: true });
    await page.screenshot({ path: amazonPaths.screenshot });
    return amazonPaths.screenshot;
  } catch {
    return undefined;
  }
}

export async function pageText(page: Page): Promise<string> {
  return (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").trim();
}
