/**
 * `blinkit setup`: browser, Blinkit login, Amazon login, delivery addresses, then doctor, in one guided
 * run. Each step is skipped when it's already done, so running it again only does what's missing.
 */
import type { Command } from "commander";
import type { AmazonNow } from "../amazon/client.js";
import type { OtpChannel } from "../amazon/login.js";
import type { Blinkit } from "../client.js";
import { ensureBrowser } from "../core/browser.js";
import { BlinkitError } from "../core/errors.js";
import { allOk, type DoctorDeps, formatChecks, runDoctor } from "../doctor.js";
import { otpSentLine } from "./amazon.js";
import { ask, confirm } from "./prompt.js";

const OTP_TRIES = 3;
const done = (m: string) => console.log(`✓ ${m}`);
const todo = (m: string) => console.log(`\n→ ${m}`);
const warn = (e: unknown) => console.log(e instanceof BlinkitError ? `✗ ${e.reason}\n  Fix: ${e.fix}` : `✗ ${e}`);

/** Pick one of `items`: the only one, or by number. Enter skips. */
async function pick<T>(items: T[], label: (t: T) => string, what: string): Promise<T | undefined> {
  if (items.length === 1) return items[0];
  for (const [i, t] of items.entries()) console.log(`  ${i + 1}. ${label(t)}`);
  for (;;) {
    const a = await ask(`Which ${what}? [1-${items.length}, Enter to skip] `);
    if (!a) return undefined;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
  }
}

/** Ask for the OTP until it's accepted or OTP_TRIES codes were rejected. */
async function enterOtp(label: string, verify: (code: string) => Promise<unknown>): Promise<boolean> {
  for (let i = 0; i < OTP_TRIES; i++) {
    const code = await ask(`${label} OTP: `);
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

async function blinkitWorks(bk: Blinkit): Promise<boolean> {
  if (!bk.loggedIn) return false;
  return bk.account.addresses().then(
    () => true,
    () => false,
  );
}

async function blinkitLogin(bk: Blinkit): Promise<void> {
  todo("Blinkit login");
  if (await blinkitWorks(bk)) return done(`Blinkit: already logged in as ${bk.account.whoami().phone ?? "you"}`);
  const phone = await ask("Blinkit mobile number (Enter to skip): ");
  if (!phone) return console.log("Skipped Blinkit.");
  await bk.account.requestOtp(phone);
  console.log("OTP sent by SMS."); // Blinkit only sends login codes by SMS
  if (await enterOtp("Blinkit", (code) => bk.account.verifyOtp(code))) done("Blinkit: logged in");
}

async function blinkitAddress(bk: Blinkit): Promise<void> {
  if (!bk.loggedIn) return;
  todo("Blinkit delivery address");
  if (bk.state.address) return done(`Blinkit: delivering to [${bk.state.address.label}] ${bk.state.address.text}`);
  const list = await bk.account.addresses();
  if (!list.length) {
    return console.log("No saved Blinkit addresses. Add one with `blinkit address add`, then run setup again.");
  }
  const a = await pick(list, (x) => `[${x.label ?? "—"}] ${x.text}`, "address");
  if (!a) return console.log("Skipped the Blinkit address.");
  const r = await bk.account.useAddress(String(a.id));
  done(`Blinkit: delivering to [${r.address.label}] ${r.address.text}`);
}

async function amazonWorks(now: AmazonNow): Promise<boolean> {
  if (!now.loggedIn) return false;
  return now.whoami().then(
    () => true,
    () => false,
  );
}

async function amazonLogin(now: AmazonNow): Promise<void> {
  todo("Amazon login");
  if (await amazonWorks(now)) return done("Amazon: already logged in");
  // Only a number typed now: never fall back to a saved one, so no OTP goes out unasked.
  const phone = await ask("Amazon mobile number (Enter to skip): ");
  if (!phone) return console.log("Skipped Amazon.");
  let via: OtpChannel = (await ask("Send the OTP by SMS or WhatsApp? [sms] ")).toLowerCase().startsWith("w")
    ? "whatsapp"
    : "sms";
  try {
    for (;;) {
      try {
        console.log("Opening Amazon sign-in (takes a few seconds)…");
        const r = await now.requestOtp(phone, via);
        // Say where it actually went: Amazon sometimes picks the other channel.
        console.log(
          r.channel === "unknown" ? `${otpSentLine(r)} (Amazon didn't say: SMS or WhatsApp)` : otpSentLine(r),
        );
        break;
      } catch (e) {
        warn(e);
        const other: OtpChannel = via === "sms" ? "whatsapp" : "sms";
        const notSent = e instanceof BlinkitError && /couldn.?t send the OTP/i.test(e.reason);
        if (!notSent || !(await confirm(`Try ${other} instead?`))) return;
        via = other;
      }
    }
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
  if (current?.serviceable) return done(`Amazon: delivering to [${current.label ?? "—"}] ${current.text}`);
  const served = list.filter((a) => a.serviceable);
  if (!served.length) {
    return console.log(
      "None of your Amazon addresses is served by Amazon Now. Add one on amazon.in, then run setup again.",
    );
  }
  const a = await pick(served, (x) => `[${x.label ?? "—"}] ${x.text}`, "address");
  if (!a) return console.log("Skipped the Amazon address.");
  const used = await now.useAddress(a.id);
  done(`Amazon: delivering to [${used.label ?? "—"}] ${used.text}`);
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
  todo("Browser");
  try {
    // The download prompt is only enabled on a terminal (see run() in main.ts); otherwise this just finds one.
    done(`Browser: ${await ensureBrowser()}`);
  } catch (e) {
    warn(e);
  }
  if (interactive) {
    // A failed step is reported and setup moves on; doctor at the end lists whatever is still missing.
    for (const step of [
      () => blinkitLogin(bk),
      () => blinkitAddress(bk),
      () => amazonLogin(now),
      () => amazonAddress(now),
    ]) {
      await step().catch(warn);
    }
  } else {
    console.log(
      "\nstdin isn't a terminal, so setup won't log in or download anything.\n" +
        "Fix: run `blinkit setup` in a terminal, or the Fix commands below.",
    );
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
