import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AmazonNow } from "../src/amazon/client.js";
import { confirm, usePromptInput } from "../src/cli/prompt.js";
import { runSetup } from "../src/cli/setup.js";
import type { Blinkit } from "../src/client.js";
import { toolFix } from "../src/mcp/tools.js";

const installBrowser = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/core/install.js", () => ({ installBrowser }));

afterEach(() => {
  vi.restoreAllMocks();
  usePromptInput(process.stdin);
});

describe("blinkit setup without a terminal", () => {
  it("sends no OTP, downloads nothing, and still prints doctor's fixes", async () => {
    const blinkitOtp = vi.fn();
    const amazonOtp = vi.fn();
    const bk = {
      loggedIn: false,
      state: { user: { id: 1, phone: "9876543210" } }, // a saved phone must not be used
      account: { requestOtp: blinkitOtp, addresses: vi.fn(), whoami: () => ({ phone: null }) },
    } as unknown as Blinkit;
    const now = { loggedIn: false, requestOtp: amazonOtp, whoami: vi.fn() } as unknown as AmazonNow;
    // Answers waiting on stdin must not be read either.
    usePromptInput(Readable.from(["9876543210\n", "y\n"]));
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));

    const ready = await runSetup({
      bk,
      now,
      interactive: false,
      doctor: { nodeVersion: "22.22.0", built: () => true, locate: () => undefined, launch: async () => {} },
    });

    expect(ready).toBe(false);
    expect(blinkitOtp).not.toHaveBeenCalled();
    expect(amazonOtp).not.toHaveBeenCalled();
    expect(installBrowser).not.toHaveBeenCalled();
    const text = out.join("\n");
    expect(text).toContain("setup won't log in or download anything");
    expect(text).toContain("✗ Amazon login");
    expect(text).toContain("Fix: run `blinkit amazon login <phone>`");
    expect(text).toMatch(/Not ready yet/);
  });
});

describe("confirm", () => {
  it("treats Enter and ended input as No", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    usePromptInput(Readable.from(["\n"]));
    expect(await confirm("Download a browser (~100 MB)?")).toBe(false);
    usePromptInput(Readable.from([]));
    expect(await confirm("Download a browser (~100 MB)?")).toBe(false);
    usePromptInput(Readable.from(["yes\n"]));
    expect(await confirm("Download a browser (~100 MB)?")).toBe(true);
  });
});

describe("MCP fixes", () => {
  it("name the tools to call instead of CLI commands", () => {
    expect(toolFix("log in again: `blinkit amazon login <phone>`")).toBe(
      "log in again: `amazon_now_login_request_otp` (the user's phone), then `amazon_now_login_verify_otp`",
    );
    expect(toolFix("wait a few minutes, then run `blinkit amazon login <phone> --via whatsapp`")).toBe(
      'wait a few minutes, then call `amazon_now_login_request_otp` with via: "whatsapp" (the user\'s phone), then `amazon_now_login_verify_otp`',
    );
    expect(toolFix("run `blinkit login <phone>`")).toBe(
      "call `blinkit_login_request_otp` (the user's phone), then `blinkit_login_verify_otp`",
    );
    expect(toolFix("your address isn't served by Amazon Now; run `blinkit amazon address` to choose another")).toBe(
      "your address isn't served by Amazon Now; call `amazon_now_addresses` to choose another",
    );
    // Things only the user can do stay as commands.
    expect(toolFix("run `npx playwright install --only-shell chromium`")).toBe(
      "run `npx playwright install --only-shell chromium`",
    );
  });
});
