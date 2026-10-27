import { describe, expect, it, vi } from "vitest";
import type { AmazonNow } from "../src/amazon/client.js";
import { otpNotSent } from "../src/amazon/login.js";
import { runSetup } from "../src/cli/setup.js";
import type { Blinkit } from "../src/client.js";
import { BlinkitError } from "../src/core/errors.js";
import { allOk, type Check, formatChecks, runDoctor } from "../src/doctor.js";

const blinkit = (loggedIn: boolean, requestOtp = vi.fn()) =>
  ({
    loggedIn,
    state: { user: { id: 1, phone: "9876543210" } },
    account: { requestOtp, addresses: async () => [], whoami: () => ({ phone: "******1234" }) },
  }) as unknown as Blinkit;

const amazon = (loggedIn: boolean, whoami: () => Promise<unknown> = vi.fn(), requestOtp = vi.fn()) =>
  ({ loggedIn, whoami, requestOtp }) as unknown as AmazonNow;

const browserOk = { find: async () => "/usr/bin/chromium", launch: async () => {} };

describe("doctor", () => {
  it("prints one line per check: ✓, or ✗ with the fix", () => {
    const checks: Check[] = [
      { name: "Blinkit", ok: true, detail: "logged in" },
      { name: "Browser", ok: false, detail: "no Chromium-based browser found", fix: "run `x`" },
    ];
    expect(formatChecks(checks)).toBe(
      ["✓ Blinkit  logged in", "✗ Browser  no Chromium-based browser found. Fix: run `x`"].join("\n"),
    );
    expect(allOk(checks)).toBe(false);
    expect(allOk(checks.slice(0, 1))).toBe(true);
  });

  it("checks the browser, Blinkit, and Amazon Now with its address", async () => {
    const whoami = async () => ({
      loggedIn: true,
      deliverTo: { label: "Home", text: "1 MG Road", serviceable: false },
    });
    const result = await runDoctor({ bk: blinkit(true), now: amazon(true, whoami), ...browserOk });
    expect(formatChecks(result).split("\n")).toEqual([
      "✓ Browser     /usr/bin/chromium",
      "✓ Blinkit     logged in as ******1234",
      "✗ Amazon Now  [Home] 1 MG Road isn't served by Amazon Now. Fix: run `blinkit amazon address`, then `blinkit amazon address use <label>`",
    ]);
  });

  it("gives every failed check a fix", async () => {
    const result = await runDoctor({ bk: blinkit(false), now: amazon(false), find: async () => undefined });
    expect(result.map((c) => [c.ok, c.fix])).toEqual([
      [false, "run `npx playwright install chromium`"],
      [false, "run `blinkit login <phone>`"],
      [false, "run `blinkit amazon login <phone>`"],
    ]);
  });

  it("says to log in again when the saved Amazon session no longer works", async () => {
    const whoami = async () => {
      throw new BlinkitError("Amazon didn't return your saved addresses (HTTP 200)");
    };
    const [, , check] = await runDoctor({ bk: blinkit(true), now: amazon(true, whoami), ...browserOk });
    expect(check).toMatchObject({ ok: false, fix: "run `blinkit amazon login <phone>`" });
  });

  it("reports a browser that is found but won't start", async () => {
    const launch = async () => {
      throw new Error("Failed to launch: missing libnss3.so\nmore detail");
    };
    const [check] = await runDoctor({ bk: blinkit(false), now: amazon(false), ...browserOk, launch });
    expect(check).toMatchObject({
      ok: false,
      detail: "/usr/bin/chromium won't start: Failed to launch: missing libnss3.so",
    });
  });
});

describe("blinkit setup without a terminal", () => {
  it("sends no OTP and still prints doctor's fixes", async () => {
    const blinkitOtp = vi.fn();
    const amazonOtp = vi.fn();
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));

    const ready = await runSetup({
      bk: blinkit(false, blinkitOtp),
      now: amazon(false, vi.fn(), amazonOtp),
      interactive: false,
      doctor: browserOk,
    });

    expect(ready).toBe(false);
    expect(blinkitOtp).not.toHaveBeenCalled();
    expect(amazonOtp).not.toHaveBeenCalled();
    const text = out.join("\n");
    expect(text).toContain("setup won't log in or download anything");
    expect(text).toContain("✗ Amazon Now  not logged in. Fix: run `blinkit amazon login <phone>`");
    expect(text).toMatch(/Not ready yet/);
    vi.restoreAllMocks();
  });
});

describe("Amazon couldn't send the OTP", () => {
  it("suggests the other channel", () => {
    expect(otpNotSent("sms").message).toBe("Amazon couldn't send the OTP; wait a few minutes or use --via whatsapp");
    expect(otpNotSent("whatsapp").message).toMatch(/--via sms$/);
  });
});
