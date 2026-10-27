/**
 * `blinkit doctor`: is this machine ready? One line per check, ✓ or ✗ with the command that fixes it.
 * Also the MCP tool `doctor`, which agents call first.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AmazonNow } from "./amazon/client.js";
import type { Blinkit } from "./client.js";
import { type FoundBrowser, INSTALL_BROWSER, locateBrowser } from "./core/browser.js";
import { BlinkitError } from "./core/errors.js";
import { AMAZON_RELOGIN } from "./core/fixes.js";

export interface Check {
  name: string;
  ok: boolean;
  /** What was found, or what's wrong. */
  detail: string;
  /** Set when !ok: what to run. */
  fix?: string;
}

export interface DoctorDeps {
  bk: Blinkit;
  now: AmazonNow;
  nodeVersion?: string;
  /** Whether the compiled CLI exists (the package was built). */
  built?: () => boolean;
  locate?: () => FoundBrowser | undefined;
  /** Start the browser headless and close it; throws when it can't. */
  launch?: (path: string) => Promise<void>;
}

const MIN_NODE = 22;
const AMAZON_ADDRESS_FIX = "your address isn't served by Amazon Now; run `blinkit amazon address` to choose another";

const pass = (name: string, detail: string): Check => ({ name, ok: true, detail });
const fail = (name: string, detail: string, fix: string): Check => ({ name, ok: false, detail, fix });
const firstLine = (e: unknown) =>
  e instanceof BlinkitError ? e.reason : (e instanceof Error ? e.message : String(e)).split("\n")[0];

const distBuilt = () => existsSync(fileURLToPath(new URL("../dist/bin/blinkit.js", import.meta.url)));

async function launchHeadless(executablePath: string): Promise<void> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 30000 });
  await browser.close();
}

export async function runDoctor(deps: DoctorDeps): Promise<Check[]> {
  const { bk, now } = deps;
  const checks: Check[] = [];

  const node = deps.nodeVersion ?? process.versions.node;
  checks.push(
    Number(node.split(".")[0]) >= MIN_NODE
      ? pass("Node.js", `v${node}`)
      : fail("Node.js", `v${node} is too old`, `install Node.js ${MIN_NODE} or newer from https://nodejs.org`),
  );

  checks.push(
    (deps.built ?? distBuilt)()
      ? pass("Build", "dist/ is built")
      : fail("Build", "dist/ is missing", "run `npm run build`"),
  );

  let browser: FoundBrowser | undefined;
  let locateError: unknown;
  try {
    browser = (deps.locate ?? locateBrowser)();
  } catch (e) {
    locateError = e; // e.g. BLINKIT_BROWSER points to a missing file
  }
  if (locateError) {
    const fix = locateError instanceof BlinkitError ? locateError.fix : `run \`${INSTALL_BROWSER}\``;
    checks.push(fail("Browser", firstLine(locateError), fix));
    checks.push(fail("Browser launch", "skipped: no usable browser", fix));
  } else if (!browser) {
    checks.push(fail("Browser", "no Chromium-based browser found", `run \`${INSTALL_BROWSER}\` or \`blinkit setup\``));
    checks.push(fail("Browser launch", "skipped: no browser", `run \`${INSTALL_BROWSER}\` or \`blinkit setup\``));
  } else {
    checks.push(pass("Browser", `${browser.path} (${browser.source})`));
    try {
      await (deps.launch ?? launchHeadless)(browser.path);
      checks.push(pass("Browser launch", "starts headless"));
    } catch (e) {
      const fix =
        browser.source === "env"
          ? "point BLINKIT_BROWSER at a working Chrome, or unset it"
          : `run \`${INSTALL_BROWSER}\`, or set BLINKIT_BROWSER to a working Chrome`;
      checks.push(fail("Browser launch", firstLine(e).slice(0, 160), fix));
    }
  }

  if (!bk.loggedIn) {
    checks.push(fail("Blinkit login", "not logged in", "run `blinkit login <phone>`"));
  } else {
    try {
      await bk.account.addresses(); // proves the saved token still works
      const phone = bk.account.whoami().phone;
      checks.push(pass("Blinkit login", `logged in${phone ? ` as ${phone}` : ""}`));
    } catch (e) {
      checks.push(
        fail("Blinkit login", firstLine(e), e instanceof BlinkitError ? e.fix : "run `blinkit login <phone>`"),
      );
    }
  }

  if (!now.loggedIn) {
    checks.push(fail("Amazon login", "not logged in", "run `blinkit amazon login <phone>`"));
    checks.push(fail("Amazon address", "skipped: not logged in", "run `blinkit amazon login <phone>`"));
    checks.push(fail("Amazon Now serves it", "skipped: not logged in", "run `blinkit amazon login <phone>`"));
    return checks;
  }
  let who: Awaited<ReturnType<AmazonNow["whoami"]>>;
  try {
    who = await now.whoami();
  } catch (e) {
    // The cookie is there but Amazon won't serve the account: whatever the error says, the session is stale.
    const fix = AMAZON_RELOGIN;
    checks.push(fail("Amazon login", firstLine(e), fix));
    checks.push(fail("Amazon address", "skipped: Amazon login failed", fix));
    checks.push(fail("Amazon Now serves it", "skipped: Amazon login failed", fix));
    return checks;
  }
  checks.push(pass("Amazon login", "logged in"));
  const to = "deliverTo" in who ? who.deliverTo : null;
  if (!to) {
    const fix = "run `blinkit amazon address`, then `blinkit amazon address use <label>`";
    checks.push(fail("Amazon address", "none selected", fix));
    checks.push(fail("Amazon Now serves it", "skipped: no address", fix));
    return checks;
  }
  const where = `[${to.label ?? "—"}] ${to.text}`;
  checks.push(pass("Amazon address", where));
  checks.push(
    to.serviceable ? pass("Amazon Now serves it", "yes") : fail("Amazon Now serves it", "no", AMAZON_ADDRESS_FIX),
  );
  return checks;
}

/** One line per check: `✓ Name: detail`, or `✗ Name: detail. Fix: command`. */
export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map((c) => {
      const line = `${c.ok ? "✓" : "✗"} ${c.name.padEnd(width)}  ${c.detail}`;
      return c.ok ? line : `${line}. Fix: ${c.fix}`;
    })
    .join("\n");
}

export const allOk = (checks: Check[]) => checks.every((c) => c.ok);
