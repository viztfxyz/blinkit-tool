/**
 * `blinkit setup`: browser, Blinkit login, Amazon login, delivery addresses, then doctor, in one guided
 * run. Each step is skipped when it's already done, so running it again only does what's missing.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { Command } from "commander";
import type { AmazonNow } from "../amazon/client.js";
import type { OtpChannel } from "../amazon/login.js";
import type { Blinkit } from "../client.js";
import { findBrowser, INSTALL_BROWSER } from "../core/browser.js";
import { allOk, type DoctorDeps, formatChecks, runDoctor } from "../doctor.js";
import { otpSentLine } from "./amazon.js";
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

async function blinkitLogin(bk: Blinkit): Promise<void> {
  todo("Blinkit login");
  if (
    bk.loggedIn &&
    (await bk.account.addresses().then(
      () => true,
      () => false,
    ))
  ) {
    return done(`Blinkit: already logged in as ${bk.account.whoami().phone ?? "you"}`);
  }
  const phone = await ask("Blinkit mobile number (Enter to skip): ");
  if (!phone) return console.log("Skipped Blinkit.");
  await bk.account.requestOtp(phone);
  console.log("OTP sent by SMS."); // Blinkit only sends login codes by SMS
  if (await enterOtp("Blinkit", (code) => bk.account.verifyOtp(code))) done("Blinkit: logged in");
}

async function blinkitAddress(bk: Blinkit): Promise<void> {
  if (!bk.loggedIn) return;
  todo("Blinkit delivery address");
  if (bk.state.address) return done(`Blinkit: delivering to ${label(bk.state.address)}`);
  const list = await bk.account.addresses();
  if (!list.length) return console.log("No saved Blinkit addresses. Add one with `blinkit address add`.");
  const a = await pick(list, label);
  if (!a) return console.log("Skipped the Blinkit address.");
  const r = await bk.account.useAddress(String(a.id));
  done(`Blinkit: delivering to ${label(r.address)}`);
}

async function amazonLogin(now: AmazonNow): Promise<void> {
  todo("Amazon login");
  if (
    now.loggedIn &&
    (await now.whoami().then(
      () => true,
      () => false,
    ))
  )
    return done("Amazon: already logged in");
  // Only a number typed now: never fall back to a saved one, so no OTP goes out unasked.
  const phone = await ask("Amazon mobile number (Enter to skip): ");
  if (!phone) return console.log("Skipped Amazon.");
  const answer = await ask("Send the OTP by SMS or WhatsApp? [sms] ");
  const via: OtpChannel = answer.toLowerCase().startsWith("w") ? "whatsapp" : "sms";
  try {
    console.log("Opening Amazon sign-in (takes a few seconds)…");
    console.log(otpSentLine(await now.requestOtp(phone, via)));
    if (await enterOtp("Amazon", (code) => now.verifyOtp(code))) done("Amazon: logged in");
  } finally {
    await now.cancelLogin(); // closes the sign-in browser if the OTP never succeeded
  }
}

async function amazonAddress(now: AmazonNow): Promise<void> {
  if (!now.loggedIn) return;
  todo("Amazon delivery address");
  const list = await now.addresses();
  const current = list.find((a) => a.selected);
  if (current?.serviceable) return done(`Amazon: delivering to ${label(current)}`);
  const served = list.filter((a) => a.serviceable);
  if (!served.length)
    return console.log("None of your Amazon addresses is served by Amazon Now. Add one on amazon.in.");
  const a = await pick(served, label);
  if (!a) return console.log("Skipped the Amazon address.");
  done(`Amazon: delivering to ${label(await now.useAddress(a.id))}`);
}

export interface SetupDeps {
  bk: Blinkit;
  now: AmazonNow;
  /** Someone at a terminal can answer. Without one, setup only checks: no OTPs, no downloads. */
  interactive: boolean;
  /** For tests: doctor's dependencies other than the clients. */
  doctor?: Omit<DoctorDeps, "bk" | "now">;
}

/** The whole guided run; true when doctor ends all ✓. */
export async function runSetup({ bk, now, interactive, doctor }: SetupDeps): Promise<boolean> {
  await browser(interactive).catch(warn);
  if (interactive) {
    // A failed step is reported and setup moves on; doctor at the end lists whatever is still missing.
    for (const step of [blinkitLogin, blinkitAddress]) await step(bk).catch(warn);
    for (const step of [amazonLogin, amazonAddress]) await step(now).catch(warn);
  } else {
    console.log("\nstdin isn't a terminal, so setup won't log in or download anything.");
  }
  todo("Checking everything (blinkit doctor)");
  const checks = await runDoctor({ ...doctor, bk, now });
  console.log(formatChecks(checks));
  const ready = allOk(checks);
  console.log(ready ? "\nReady" : "\nNot ready yet: run the Fix commands above, or `blinkit setup` again.");
  return ready;
}

export function registerSetup(program: Command, bk: () => Blinkit, now: () => AmazonNow): void {
  program
    .command("setup")
    .description("guided setup: browser, Blinkit and Amazon login, delivery address, then doctor (safe to rerun)")
    .action(async () => {
      const ready = await runSetup({ bk: bk(), now: now(), interactive: !!process.stdin.isTTY });
      if (!ready) process.exitCode = 1;
    });
}
