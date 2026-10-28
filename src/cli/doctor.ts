/**
 * `handcart doctor` and the MCP tool of the same name: one ✓/✗ line per check, with the command that
 * fixes a ✗. Everything past the browser comes from the registry, so a new platform is checked too.
 */
import { findBrowser, INSTALL_BROWSER } from "../core/browser.js";
import { client, type PlatformDescriptor, platforms } from "../platforms/registry.js";

export interface Check {
  name: string;
  ok: boolean;
  /** What was found, or what's wrong. */
  detail: string;
  /** Set when !ok: what to run. */
  fix?: string;
}

export interface DoctorDeps {
  /** Platforms to check; defaults to the whole registry. */
  only?: PlatformDescriptor[];
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
    const fix = `run \`${INSTALL_BROWSER}\`, or set HANDCART_BROWSER to a working Chrome`;
    return { name, ok: false, detail: `${path} won't start: ${firstLine(e)}`, fix };
  }
}

/** Logged in, the saved session still works, and there is somewhere to deliver to. */
async function platformCheck(d: PlatformDescriptor): Promise<Check> {
  const name = d.label;
  const fix = `run \`handcart ${d.name} login <phone>\``;
  const p = client(d);
  let who: Awaited<ReturnType<typeof p.whoami>>;
  try {
    who = await p.whoami();
  } catch (e) {
    return { name, ok: false, detail: firstLine(e), fix };
  }
  if (!who.loggedIn) return { name, ok: false, detail: "not logged in", fix };
  try {
    await p.addresses(); // proves the saved token still works
  } catch (e) {
    return { name, ok: false, detail: firstLine(e), fix };
  }
  const to = who.deliverTo;
  const pick = `run \`handcart ${d.name} address\`, then \`handcart ${d.name} address use <label>\``;
  if (!to) return { name, ok: false, detail: "logged in, no delivery address selected", fix: pick };
  return { name, ok: true, detail: `delivering to [${to.label ?? "—"}] ${to.text}` };
}

export function runDoctor(deps: DoctorDeps = {}): Promise<Check[]> {
  const list = deps.only ?? platforms();
  return Promise.all([browserCheck(deps), ...list.map(platformCheck)]);
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
