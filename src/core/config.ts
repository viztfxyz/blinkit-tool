import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** package.json sits two levels above src/core/ and dist/core/. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** Where the project kept sessions and caches before the rename to handcart. */
const LEGACY_DIR = "blinkit-tool";
const APP_DIR = "handcart";

/**
 * Move `~/.config/blinkit-tool` and `~/.cache/blinkit-tool` to the handcart names. Without this every
 * existing user silently loses their logins on the first handcart run. Only ever moves into a name that
 * doesn't exist yet, so it can't clobber a handcart directory and does nothing on the second run.
 */
export function migrateLegacyDirs(home: string = homedir(), log: (msg: string) => void = console.error): void {
  const moved: string[] = [];
  for (const kind of [".config", ".cache"]) {
    const from = join(home, kind, LEGACY_DIR);
    const to = join(home, kind, APP_DIR);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      renameSync(from, to);
      moved.push(`${kind}/${LEGACY_DIR}`);
    } catch {
      // can't move it: the user keeps the old directory, and handcart starts fresh rather than failing
    }
  }
  if (moved.length) log(`handcart: moved ~/{${moved.join(",")}} to ~/{.config,.cache}/${APP_DIR} (renamed project).`);
}

migrateLegacyDirs();

export const CACHE_DIR = join(homedir(), ".cache", APP_DIR);
export const CONFIG_DIR = join(homedir(), ".config", APP_DIR);

const deprecated = new Set<string>();

/**
 * `HANDCART_<name>`, or the pre-rename `BLINKIT_<name>` with a one-line notice. Platform-scoped names
 * (`BLINKIT_SESSION`, `ZEPTO_COOKIES`…) are read directly and keep their platform's prefix.
 */
export function env(name: string): string | undefined {
  const current = process.env[`HANDCART_${name}`];
  if (current) return current;
  const legacy = process.env[`BLINKIT_${name}`];
  if (legacy && !deprecated.has(name)) {
    deprecated.add(name);
    console.error(`handcart: BLINKIT_${name} is deprecated; use HANDCART_${name}.`);
  }
  return legacy;
}

/** qrbaton (https://qrbaton.vercel.app) turns the UPI intent + cart into a pay page. Override to self-host. */
export const QRBATON_URL = (process.env.QRBATON_URL ?? "https://qrbaton.vercel.app").replace(/\/$/, "");
