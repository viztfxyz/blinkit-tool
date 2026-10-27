/**
 * `blinkit doctor` and the MCP tool `doctor`: one ✓/✗ line per check, with the command that fixes a ✗.
 */
import type { AmazonNow } from "./amazon/client.js";
import type { Blinkit } from "./client.js";
import { findBrowser, INSTALL_BROWSER } from "./core/browser.js";

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
  find?: () => Promise<string | undefined>;
  /** Start the browser headless and close it; throws when it can't. */
  launch?: (path: string) => Promise<void>;
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160);

async function launchHeadless(executablePath: string): Promise<void> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 30000 });
  await browser.close();
}

async function browserCheck({ find = findBrowser, launch = launchHeadless }: DoctorDeps): Promise<Check> {
  const name = "Browser";
  const path = await find();
  if (!path) return { name, ok: false, detail: "no Chromium-based browser found", fix: `run \`${INSTALL_BROWSER}\`` };
  try {
    await launch(path);
    return { name, ok: true, detail: path };
  } catch (e) {
    const fix = `run \`${INSTALL_BROWSER}\`, or set BLINKIT_BROWSER to a working Chrome`;
    return { name, ok: false, detail: `${path} won't start: ${firstLine(e)}`, fix };
  }
}

async function blinkitCheck(bk: Blinkit): Promise<Check> {
  const name = "Blinkit";
  const fix = "run `blinkit login <phone>`";
  if (!bk.loggedIn) return { name, ok: false, detail: "not logged in", fix };
  try {
    await bk.account.addresses(); // proves the saved token still works
  } catch (e) {
    return { name, ok: false, detail: firstLine(e), fix };
  }
  const phone = bk.account.whoami().phone;
  return { name, ok: true, detail: `logged in${phone ? ` as ${phone}` : ""}` };
}

async function amazonCheck(now: AmazonNow): Promise<Check> {
  const name = "Amazon Now";
  const fix = "run `blinkit amazon login <phone>`";
  if (!now.loggedIn) return { name, ok: false, detail: "not logged in", fix };
  let who: Awaited<ReturnType<AmazonNow["whoami"]>>;
  try {
    who = await now.whoami();
  } catch (e) {
    return { name, ok: false, detail: firstLine(e), fix }; // the saved session no longer works
  }
  const to = "deliverTo" in who ? who.deliverTo : null;
  const pick = "run `blinkit amazon address`, then `blinkit amazon address use <label>`";
  if (!to) return { name, ok: false, detail: "logged in, no delivery address selected", fix: pick };
  const where = `[${to.label ?? "—"}] ${to.text}`;
  return to.serviceable
    ? { name, ok: true, detail: `delivering to ${where}` }
    : { name, ok: false, detail: `${where} isn't served by Amazon Now`, fix: pick };
}

export function runDoctor(deps: DoctorDeps): Promise<Check[]> {
  return Promise.all([browserCheck(deps), blinkitCheck(deps.bk), amazonCheck(deps.now)]);
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
