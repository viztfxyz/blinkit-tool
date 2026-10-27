/**
 * `handcart setup`: the browser, then every registered platform's login and delivery address, then
 * doctor, in one guided run. Each step is skipped when it's already done, so running it again only
 * does what's missing. The platform steps come from the registry, so a new store is set up too.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { Command } from "commander";
import { findBrowser, INSTALL_BROWSER } from "../core/browser.js";
import { can, client, type PlatformDescriptor, platforms } from "../platforms/registry.js";
import { allOk, type DoctorDeps, formatChecks, runDoctor } from "./doctor.js";
import { ask, confirm } from "./prompt.js";

const OTP_TRIES = 3;
const done = (m: string) => console.log(`✓ ${m}`);
const todo = (m: string) => console.log(`\n→ ${m}`);
const warn = (e: unknown) => console.log(`✗ ${e instanceof Error ? e.message : e}`);
const label = (a: { label?: string | null; text: string }) => `[${a.label ?? "—"}] ${a.text}`;

/** Pick one of `items`: the only one, or by number. Enter skips. */
async function pick<T>(items: T[], show: (t: T) => string): Promise<T | undefined> {
  if (items.length === 1) return items[0];
  for (const [i, t] of items.entries()) console.log(`  ${i + 1}. ${show(t)}`);
  for (;;) {
    const a = await ask(`Which one? [1-${items.length}, Enter to skip] `);
    if (!a) return undefined;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
  }
}

/** Ask for the OTP until it's accepted or OTP_TRIES codes were rejected. */
async function enterOtp(name: string, verify: (code: string) => Promise<unknown>): Promise<boolean> {
  for (let i = 0; i < OTP_TRIES; i++) {
    const code = await ask(`${name} OTP: `);
    if (!code) return false;
    try {
      await verify(code);
      return true;
    } catch (e) {
      warn(e);
    }
  }
  return false;
}

/** `npx playwright install chromium`, from our own playwright-core so the build matches what launches it. */
function installChromium(): Promise<void> {
  const cli = createRequire(import.meta.url).resolve("playwright-core/cli.js");
  return new Promise((resolve, reject) => {
    spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" })
      .on("error", reject)
      .on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`playwright install exited with ${code}`))));
  });
}

async function browser(interactive: boolean): Promise<void> {
  todo("Browser");
  const found = await findBrowser();
  if (found) return done(`Browser: ${found}`);
  if (!interactive || !(await confirm("No Chromium-based browser found. Download one with Playwright?"))) {
    return console.log(`Skipped. Install Chrome, or run \`${INSTALL_BROWSER}\`.`);
  }
  await installChromium();
  done(`Browser: ${await findBrowser()}`);
}

/** Whether the saved session is still usable, swallowing the reason: the step re-logs in either way. */
const usable = (d: PlatformDescriptor) =>
  client(d.name)
    .whoami()
    .then(
      (w) => (w.loggedIn ? w : undefined),
      () => undefined,
    );

async function login(d: PlatformDescriptor): Promise<void> {
  todo(`${d.label} login`);
  const p = client(d.name);
  const who = await usable(d);
  // whoami can be satisfied by a stale token; addresses() is the call that proves it still works.
  if (
    who &&
    (await p.addresses().then(
      () => true,
      () => false,
    ))
  ) {
    return done(`${d.label}: already logged in`);
  }
  // Only a number typed now: never fall back to a saved one, so no OTP goes out unasked.
  const phone = await ask(`${d.label} mobile number (Enter to skip): `);
  if (!phone) return console.log(`Skipped ${d.label}.`);
  console.log(`OTP sent by SMS to ${(await p.requestOtp(phone)).to}.`);
  if (await enterOtp(d.label, (code) => p.verifyOtp(code))) done(`${d.label}: logged in`);
}

async function address(d: PlatformDescriptor): Promise<void> {
  const who = await usable(d);
  if (!who) return; // login was skipped or failed; doctor says so at the end
  todo(`${d.label} delivery address`);
  if (who.deliverTo) return done(`${d.label}: delivering to ${label(who.deliverTo)}`);
  const p = client(d.name);
  const served = (await p.addresses()).filter((a) => a.serviceable !== false);
  if (!served.length) {
    return console.log(`No ${d.label} address is deliverable here. Add one in the ${d.label} app.`);
  }
  const a = await pick(served, label);
  if (!a) return console.log(`Skipped the ${d.label} address.`);
  done(`${d.label}: delivering to ${label(await p.useAddress(a.id))}`);
}

export interface SetupDeps {
  /** Platforms to set up; defaults to the whole registry. */
  only?: PlatformDescriptor[];
  /** Someone at a terminal can answer. Without one, setup only checks: no OTPs, no downloads. */
  interactive: boolean;
  /** For tests: doctor's dependencies other than the platform list. */
  doctor?: Omit<DoctorDeps, "only">;
}

/** The whole guided run; true when doctor ends all ✓. */
export async function runSetup({ only, interactive, doctor }: SetupDeps): Promise<boolean> {
  await browser(interactive).catch(warn);
  const list = only ?? platforms();
  if (interactive) {
    // A failed step is reported and setup moves on; doctor at the end lists whatever is still missing.
    for (const d of list) {
      if (can(d, "login")) await login(d).catch(warn);
      if (can(d, "addresses")) await address(d).catch(warn);
    }
  } else {
    console.log("\nstdin isn't a terminal, so setup won't log in or download anything.");
  }
  todo("Checking everything (handcart doctor)");
  const checks = await runDoctor({ ...doctor, only: list });
  console.log(formatChecks(checks));
  const ready = allOk(checks);
  console.log(ready ? "\nReady" : "\nNot ready yet: run the Fix commands above, or `handcart setup` again.");
  return ready;
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("guided setup: browser, then each platform's login and delivery address, then doctor (safe to rerun)")
    .action(async () => {
      const ready = await runSetup({ interactive: !!process.stdin.isTTY });
      if (!ready) process.exitCode = 1;
    });
}
