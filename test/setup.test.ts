import { describe, expect, it, vi } from "vitest";
import { allOk, type Check, formatChecks, runDoctor } from "../src/cli/doctor.js";
import { runSetup } from "../src/cli/setup.js";
import { HandcartError } from "../src/core/errors.js";
import type { Platform, PlatformDescriptor } from "../src/platforms/registry.js";

/** A platform that answers only what doctor and setup ask of it. */
const fake = (
  name: string,
  label: string,
  p: Partial<Platform>,
  capabilities: PlatformDescriptor["capabilities"] = ["login", "addresses"],
): PlatformDescriptor => ({
  name,
  label,
  capabilities,
  create: () => ({ addresses: async () => [], ...p }) as Platform,
});

const loggedOut = (name = "blinkit", label = "Blinkit") =>
  fake(name, label, { whoami: async () => ({ loggedIn: false, deliverTo: null }) });

const delivering = (name: string, label: string, to = "1 MG Road") =>
  fake(name, label, { whoami: async () => ({ loggedIn: true, deliverTo: { label: "Home", text: to } }) });

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

  it("checks the browser and every platform it is given, with their addresses", async () => {
    const checks = await runDoctor({
      only: [delivering("blinkit", "Blinkit"), delivering("zepto", "Zepto", "2 Park St")],
      ...browserOk,
    });
    expect(formatChecks(checks).split("\n")).toEqual([
      "✓ Browser  /usr/bin/chromium",
      "✓ Blinkit  delivering to [Home] 1 MG Road",
      "✓ Zepto    delivering to [Home] 2 Park St",
    ]);
  });

  it("gives every failed check a fix", async () => {
    const checks = await runDoctor({
      only: [loggedOut(), loggedOut("zepto", "Zepto")],
      find: async () => undefined,
    });
    expect(checks.map((c) => [c.ok, c.fix])).toEqual([
      [false, "run `npx playwright install chromium`"],
      [false, "run `handcart blinkit login <phone>`"],
      [false, "run `handcart zepto login <phone>`"],
    ]);
  });

  it("says to log in again when the saved session no longer works", async () => {
    const stale = fake("zepto", "Zepto", {
      whoami: async () => ({ loggedIn: true, deliverTo: { label: "Home", text: "2 Park St" } }),
      addresses: async () => {
        throw new HandcartError("Zepto session expired; run `handcart zepto login <phone>` again");
      },
    });
    const [, check] = await runDoctor({ only: [stale], ...browserOk });
    expect(check).toMatchObject({ ok: false, fix: "run `handcart zepto login <phone>`" });
  });

  it("asks for an address when the login works but nothing is selected", async () => {
    const noAddress = fake("zepto", "Zepto", { whoami: async () => ({ loggedIn: true, deliverTo: null }) });
    const [, check] = await runDoctor({ only: [noAddress], ...browserOk });
    expect(check).toMatchObject({
      ok: false,
      detail: "logged in, no delivery address selected",
      fix: "run `handcart zepto address`, then `handcart zepto address use <label>`",
    });
  });

  it("reports a browser that is found but won't start", async () => {
    const launch = async () => {
      throw new Error("Failed to launch: missing libnss3.so\nmore detail");
    };
    const [check] = await runDoctor({ only: [], ...browserOk, launch });
    expect(check).toMatchObject({
      ok: false,
      detail: "/usr/bin/chromium won't start: Failed to launch: missing libnss3.so",
    });
  });
});

describe("setup without a terminal", () => {
  it("sends no OTP and still prints doctor's fixes", async () => {
    const requestOtp = vi.fn();
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));

    const ready = await runSetup({
      only: [fake("blinkit", "Blinkit", { whoami: async () => ({ loggedIn: false, deliverTo: null }), requestOtp })],
      interactive: false,
      doctor: browserOk,
    });

    expect(ready).toBe(false);
    expect(requestOtp).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("✗ Blinkit  not logged in. Fix: run `handcart blinkit login <phone>`");
    vi.restoreAllMocks();
  });
});
