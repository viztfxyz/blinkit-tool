/**
 * Finds a Chromium-based browser for the steps that need a real page (Zepto's bot-check token, Blinkit
 * `pay --browser`): $HANDCART_BROWSER, Playwright's own Chromium, then Chrome / Edge / Brave / Chromium.
 */
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { delimiter, join } from "node:path";
import { env } from "./config.js";
import { HandcartError } from "./errors.js";

export const INSTALL_BROWSER = "npx playwright install chromium";

/** Skip Homebrew-style wrappers whose `exec` target is missing (e.g. chromium → Chromium.app). */
function isRunnableBrowser(bin: string | undefined): bin is string {
  if (!bin || !existsSync(bin)) return false;
  try {
    // Only the first bytes: the browser binary itself is hundreds of MB.
    const buf = Buffer.alloc(400);
    const fd = openSync(bin, "r");
    const head = buf.subarray(0, readSync(fd, buf, 0, 400, 0)).toString("utf8");
    closeSync(fd);
    if (!head.startsWith("#!")) return true;
    const m = head.match(/\bexec\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
    const target = m?.[1] ?? m?.[2] ?? m?.[3];
    return !target || existsSync(target);
  } catch {
    return false; // a directory, or unreadable
  }
}

export async function findBrowser(): Promise<string | undefined> {
  const chosen = env("BROWSER");
  if (chosen) return chosen;
  const { chromium } = await import("playwright-core");
  // Where `npx playwright install chromium` puts it on this OS, for the playwright-core version we launch with.
  let playwright: string | undefined;
  try {
    playwright = chromium.executablePath();
  } catch {}
  const mac = ["Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge", "Arc"].map(
    (app) => `/Applications/${app}.app/Contents/MacOS/${app}`,
  );
  const win = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
    .filter((dir): dir is string => !!dir)
    .flatMap((dir) => [
      join(dir, "Google/Chrome/Application/chrome.exe"),
      join(dir, "Microsoft/Edge/Application/msedge.exe"),
    ]);
  const names = [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "brave",
    "microsoft-edge",
  ];
  const onPath = (process.env.PATH ?? "").split(delimiter).flatMap((dir) => names.map((n) => join(dir, n)));
  return [playwright, ...mac, ...win, ...onPath].find(isRunnableBrowser);
}

export async function requireBrowser(): Promise<string> {
  const path = await findBrowser();
  if (!path) {
    throw new HandcartError(
      `no Chromium-based browser found; install Chrome, run \`${INSTALL_BROWSER}\`, or set HANDCART_BROWSER`,
    );
  }
  return path;
}
