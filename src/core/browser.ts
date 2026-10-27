/**
 * Finds a Chromium-based browser for the steps that need a real page (Amazon login and pay, Blinkit
 * `pay --browser`). Search order: $BLINKIT_BROWSER, the browser remembered in config.json, the Playwright
 * cache, Chrome / Edge / Brave / Chromium at their standard install paths, then $PATH. The first browser
 * the search finds is remembered so later runs skip it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { paths } from "./config.js";
import { BlinkitError } from "./errors.js";
import { INSTALL_BROWSER, INSTALL_HEADED_BROWSER } from "./fixes.js";
import { readJson, writeJson } from "./storage.js";

export { INSTALL_BROWSER, INSTALL_HEADED_BROWSER };

export type BrowserSource = "env" | "config" | "playwright" | "installed" | "path";

export interface FoundBrowser {
  path: string;
  source: BrowserSource;
  /** Playwright's chrome-headless-shell: it can't open a window. */
  headlessOnly: boolean;
}

/** What the search touches, so tests can fake a machine. */
export interface BrowserSystem {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** The file exists and can be started. */
  runnable(path: string): boolean;
  list(dir: string): string[];
  configFile: string;
}

export interface BlinkitConfig {
  browser?: string;
}

/** Skip Homebrew-style wrappers whose `exec` target is missing (e.g. chromium → Chromium.app). */
function isRunnableBrowser(bin: string): boolean {
  if (!existsSync(bin)) return false;
  try {
    const head = readFileSync(bin, "utf8").slice(0, 400);
    if (!head.startsWith("#!")) return true;
    const m = head.match(/\bexec\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
    const target = m?.[1] ?? m?.[2] ?? m?.[3];
    return !target || existsSync(target);
  } catch {
    return true; // binary, not a script
  }
}

export const realSystem = (): BrowserSystem => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
  runnable: isRunnableBrowser,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  configFile: paths.config,
});

export const isHeadlessShell = (path: string) => /headless[_-]shell/i.test(path);

/** Where `playwright install` puts browsers on each OS (or $PLAYWRIGHT_BROWSERS_PATH). */
function playwrightRoot(sys: BrowserSystem): string {
  const { join } = sys.platform === "win32" ? win32 : posix;
  if (sys.env.PLAYWRIGHT_BROWSERS_PATH) return sys.env.PLAYWRIGHT_BROWSERS_PATH;
  if (sys.platform === "darwin") return join(sys.home, "Library", "Caches", "ms-playwright");
  if (sys.platform === "win32")
    return join(sys.env.LOCALAPPDATA ?? join(sys.home, "AppData", "Local"), "ms-playwright");
  return join(sys.home, ".cache", "ms-playwright");
}

/** Browsers in the Playwright cache, newest build first; full Chromium before the headless shell. */
function playwrightCandidates(sys: BrowserSystem): string[] {
  const { join } = sys.platform === "win32" ? win32 : posix;
  const root = playwrightRoot(sys);
  const bins: Record<string, string[]> = {
    chromium: [
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
      "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-win64/chrome.exe",
      "chrome-win/chrome.exe",
    ],
    chromium_headless_shell: [
      "chrome-headless-shell-linux64/chrome-headless-shell",
      "chrome-linux/headless_shell",
      "chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "chrome-headless-shell-mac-x64/chrome-headless-shell",
      "chrome-headless-shell-win64/chrome-headless-shell.exe",
      "chrome-win/headless_shell.exe",
    ],
  };
  const out: string[] = [];
  for (const kind of Object.keys(bins)) {
    const builds = sys
      .list(root)
      .filter((d) => new RegExp(`^${kind}-\\d+$`).test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const build of builds) for (const bin of bins[kind]) out.push(join(root, build, bin));
  }
  return out;
}

/** Chrome, Edge, Brave and Chromium at their standard install paths for this OS. */
function installedCandidates(sys: BrowserSystem): string[] {
  if (sys.platform === "darwin") {
    const apps = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Arc"];
    return ["/Applications", posix.join(sys.home, "Applications")].flatMap((dir) =>
      apps.map((app) => `${dir}/${app}.app/Contents/MacOS/${app}`),
    );
  }
  if (sys.platform === "win32") {
    const dirs = [sys.env.PROGRAMFILES, sys.env["PROGRAMFILES(X86)"], sys.env.LOCALAPPDATA].filter(
      (dir): dir is string => !!dir,
    );
    const exes = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "Chromium\\Application\\chrome.exe",
    ];
    return exes.flatMap((exe) => dirs.map((dir) => win32.join(dir, exe)));
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/microsoft-edge",
    "/opt/microsoft/msedge/msedge",
    "/usr/bin/brave-browser",
    "/opt/brave.com/brave/brave",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

function pathCandidates(sys: BrowserSystem): string[] {
  const { join, delimiter } = sys.platform === "win32" ? win32 : posix;
  const names = [
    "google-chrome-stable",
    "google-chrome",
    "chrome",
    "microsoft-edge",
    "msedge",
    "brave-browser",
    "brave",
    "chromium",
    "chromium-browser",
  ].map((n) => (sys.platform === "win32" ? `${n}.exe` : n));
  const dirs = (sys.env.PATH ?? sys.env.Path ?? "").split(delimiter).filter(Boolean);
  return dirs.flatMap((dir) => names.map((n) => join(dir, n)));
}

/** Every place the search looks, in order. Exported for tests. */
export function browserCandidates(sys: BrowserSystem): { path: string; source: BrowserSource }[] {
  return [
    ...playwrightCandidates(sys).map((path) => ({ path, source: "playwright" as const })),
    ...installedCandidates(sys).map((path) => ({ path, source: "installed" as const })),
    ...pathCandidates(sys).map((path) => ({ path, source: "path" as const })),
  ];
}

/**
 * The browser to use, or undefined. `headed`: it must be able to open a window, so the headless
 * shell doesn't count. Remembers what the search found in config.json.
 */
export function locateBrowser(
  opts: { headed?: boolean } = {},
  sys: BrowserSystem = realSystem(),
): FoundBrowser | undefined {
  const usable = (path: string) => !(opts.headed && isHeadlessShell(path));
  const found = (path: string, source: BrowserSource) => ({ path, source, headlessOnly: isHeadlessShell(path) });
  const fromEnv = sys.env.BLINKIT_BROWSER;
  if (fromEnv) return found(fromEnv, "env");
  const config = readJson<BlinkitConfig>(sys.configFile) ?? {};
  if (config.browser && usable(config.browser) && sys.runnable(config.browser)) return found(config.browser, "config");
  const hit = browserCandidates(sys).find((c) => usable(c.path) && sys.runnable(c.path));
  if (!hit) return undefined;
  // Remember a full browser over a headless shell: it covers every step.
  if (!config.browser || !sys.runnable(config.browser) || isHeadlessShell(config.browser)) {
    writeJson(sys.configFile, { ...config, browser: hit.path });
  }
  return found(hit.path, hit.source);
}

/** Path of the browser to launch, or undefined (see `locateBrowser`). */
export function findBrowser(opts: { headed?: boolean } = {}): string | undefined {
  return locateBrowser(opts)?.path;
}

let askToDownload: ((question: string) => Promise<boolean>) | undefined;

/** Let `ensureBrowser` offer to download one (the CLI on a terminal). Over MCP nobody can answer, so it doesn't. */
export function allowBrowserDownload(ask: (question: string) => Promise<boolean>): void {
  askToDownload = ask;
}

/** `findBrowser`, offering to download the headless shell when there is none and someone can say yes. */
export async function ensureBrowser(opts: { headed?: boolean } = {}): Promise<string> {
  const found = findBrowser(opts);
  if (found) return found;
  if (opts.headed) {
    throw new BlinkitError("no Chromium-based browser that can open a window was found", {
      fix: `install Google Chrome, or run \`${INSTALL_HEADED_BROWSER}\``,
    });
  }
  if (!askToDownload || !(await askToDownload("Download a browser (~100 MB)?"))) {
    throw new BlinkitError("no Chromium-based browser found");
  }
  const { installBrowser } = await import("./install.js");
  await installBrowser();
  const installed = findBrowser(opts);
  if (!installed)
    throw new BlinkitError("the browser download finished but no browser was found", {
      fix: `run \`${INSTALL_BROWSER}\` and check where it installs, then set BLINKIT_BROWSER to that path`,
    });
  return installed;
}
