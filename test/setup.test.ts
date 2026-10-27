import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AmazonNow } from "../src/amazon/client.js";
import { otpNotSent } from "../src/amazon/login.js";
import type { Blinkit } from "../src/client.js";
import { type BrowserSystem, browserCandidates, locateBrowser } from "../src/core/browser.js";
import { BlinkitError } from "../src/core/errors.js";
import { fixFor } from "../src/core/fixes.js";
import { downloadResumable, parseDryRun } from "../src/core/install.js";
import { allOk, type Check, formatChecks, runDoctor } from "../src/doctor.js";

const tmp = () => mkdtempSync(join(tmpdir(), "blinkit-setup-"));

/** A fake machine: only `files` exist; `dirs` lists directory contents. */
function machine(over: Partial<BrowserSystem> & { files?: string[]; dirs?: Record<string, string[]> } = {}) {
  const files = new Set(over.files ?? []);
  const probed: string[] = [];
  const sys: BrowserSystem = {
    platform: "linux",
    env: {},
    home: "/home/u",
    runnable: (p) => {
      probed.push(p);
      return files.has(p);
    },
    list: (d) => over.dirs?.[d] ?? [],
    configFile: join(tmp(), "config.json"),
    ...over,
  };
  return { sys, probed };
}

const SHELL_DIR = "/home/u/.cache/ms-playwright";
const shell = `${SHELL_DIR}/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`;
const pwChromium = `${SHELL_DIR}/chromium-1243/chrome-linux64/chrome`;

describe("browser search order", () => {
  const everything = {
    files: [shell, pwChromium, "/usr/bin/google-chrome-stable", "/opt/bin/chromium"],
    dirs: { [SHELL_DIR]: ["chromium-1243", "chromium_headless_shell-1248", "ffmpeg-1013"] },
  };

  it("takes BLINKIT_BROWSER before anything else", () => {
    const { sys, probed } = machine({
      ...everything,
      files: [...everything.files, "/my/chrome"],
      env: { BLINKIT_BROWSER: "/my/chrome", PATH: "/opt/bin" },
    });
    expect(locateBrowser({}, sys)).toEqual({ path: "/my/chrome", source: "env", headlessOnly: false });
    expect(probed).toEqual(["/my/chrome"]);
  });

  it("refuses a BLINKIT_BROWSER that points to a missing file, instead of searching", () => {
    const { sys, probed } = machine({ ...everything, env: { BLINKIT_BROWSER: "/gone/chrome", PATH: "/opt/bin" } });
    const err = (() => {
      try {
        locateBrowser({}, sys);
      } catch (e) {
        return e as BlinkitError;
      }
    })();
    expect(err).toBeInstanceOf(BlinkitError);
    expect(err?.reason).toBe("BLINKIT_BROWSER points to a missing file (/gone/chrome)");
    expect(err?.fix).toMatch(/set BLINKIT_BROWSER to the path of your Chrome, or unset it/);
    expect(probed).toEqual(["/gone/chrome"]);
  });

  it("finds playwright-core 1.64's Chrome for Testing on macOS", () => {
    const cache = "/home/u/Library/Caches/ms-playwright";
    const cft = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    for (const arch of ["chrome-mac-arm64", "chrome-mac-x64"]) {
      const bin = `${cache}/chromium-1248/${arch}/${cft}`;
      const { sys } = machine({ platform: "darwin", files: [bin], dirs: { [cache]: ["chromium-1248"] } });
      expect(locateBrowser({ headed: true }, sys)).toMatchObject({ path: bin, source: "playwright" });
    }
  });

  it("then the Playwright cache (full Chromium before the headless shell), then standard paths, then PATH", () => {
    const { sys } = machine({ ...everything, env: { PATH: "/opt/bin" } });
    expect(locateBrowser({}, sys)?.path).toBe(pwChromium);

    const noFull = machine({
      ...everything,
      files: [shell, "/usr/bin/google-chrome-stable"],
      env: { PATH: "/opt/bin" },
    });
    expect(locateBrowser({}, noFull.sys)).toMatchObject({ path: shell, source: "playwright", headlessOnly: true });

    const noCache = machine({
      files: ["/usr/bin/google-chrome-stable", "/opt/bin/chromium"],
      env: { PATH: "/opt/bin" },
    });
    expect(locateBrowser({}, noCache.sys)).toMatchObject({
      path: "/usr/bin/google-chrome-stable",
      source: "installed",
    });

    const onlyPath = machine({ files: ["/opt/bin/chromium"], env: { PATH: "/usr/bin:/opt/bin" } });
    expect(locateBrowser({}, onlyPath.sys)).toMatchObject({ path: "/opt/bin/chromium", source: "path" });

    expect(locateBrowser({}, machine({ env: { PATH: "/opt/bin" } }).sys)).toBeUndefined();
  });

  it("orders the candidates cache → installed → PATH, newest Playwright build first", () => {
    const { sys } = machine({
      env: { PATH: "/opt/bin" },
      dirs: { [SHELL_DIR]: ["chromium-1200", "chromium-1243"] },
    });
    const c = browserCandidates(sys);
    const sources = c.map((x) => x.source);
    expect(sources.indexOf("installed")).toBeGreaterThan(sources.lastIndexOf("playwright"));
    expect(sources.indexOf("path")).toBeGreaterThan(sources.lastIndexOf("installed"));
    expect(c[0].path).toBe(pwChromium);
  });

  it("skips the headless shell when a window is needed", () => {
    const { sys } = machine({ files: [shell], dirs: { [SHELL_DIR]: ["chromium_headless_shell-1248"] } });
    expect(locateBrowser({ headed: true }, sys)).toBeUndefined();
    expect(locateBrowser({}, sys)?.path).toBe(shell);
  });

  it("knows each OS's standard paths and Playwright cache", () => {
    const mac = machine({
      platform: "darwin",
      files: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    });
    expect(locateBrowser({}, mac.sys)?.path).toBe("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    const macCache = "/home/u/Library/Caches/ms-playwright";
    const macShell = `${macCache}/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
    const mac2 = machine({
      platform: "darwin",
      files: [macShell],
      dirs: { [macCache]: ["chromium_headless_shell-1248"] },
    });
    expect(locateBrowser({}, mac2.sys)?.path).toBe(macShell);

    const brave = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
    const win = machine({ platform: "win32", env: { PROGRAMFILES: "C:\\Program Files" }, files: [brave] });
    expect(locateBrowser({}, win.sys)?.path).toBe(brave);
    const winPath = machine({ platform: "win32", env: { PATH: "C:\\tools;D:\\bin" }, files: ["D:\\bin\\chrome.exe"] });
    expect(locateBrowser({}, winPath.sys)?.path).toBe("D:\\bin\\chrome.exe");

    const linux = machine({ files: ["/opt/brave.com/brave/brave", "/usr/bin/chromium"] });
    expect(locateBrowser({}, linux.sys)?.path).toBe("/opt/brave.com/brave/brave");
  });

  it("remembers what it found, so the next run skips the search", () => {
    const first = machine({ files: ["/usr/bin/chromium"] });
    expect(locateBrowser({}, first.sys)?.path).toBe("/usr/bin/chromium");
    expect(JSON.parse(readFileSync(first.sys.configFile, "utf8"))).toEqual({ browser: "/usr/bin/chromium" });

    const again = machine({ files: ["/usr/bin/chromium"], configFile: first.sys.configFile });
    expect(locateBrowser({}, again.sys)).toMatchObject({ path: "/usr/bin/chromium", source: "config" });
    expect(again.probed).toEqual(["/usr/bin/chromium"]);
  });

  it("searches again when the remembered browser is gone", () => {
    const { sys } = machine({ files: ["/usr/bin/google-chrome"] });
    writeFileSync(sys.configFile, JSON.stringify({ browser: "/gone/chrome" }));
    expect(locateBrowser({}, sys)?.path).toBe("/usr/bin/google-chrome");
    expect(JSON.parse(readFileSync(sys.configFile, "utf8")).browser).toBe("/usr/bin/google-chrome");
  });
});

describe("browser download", () => {
  it("reads the headless shell's URLs from playwright's dry run", () => {
    const out = [
      "Chrome Headless Shell 156.0.8078.4 (playwright chromium-headless-shell v1248)",
      "  Install location:    /home/u/.cache/ms-playwright/chromium_headless_shell-1248",
      "  Download url:        https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux64/chrome-headless-shell-linux64.zip",
      "",
      "FFmpeg (playwright ffmpeg v1013)",
      "  Install location:    /home/u/.cache/ms-playwright/ffmpeg-1013",
      "  Download url:        https://cdn.playwright.dev/builds/ffmpeg/1013/ffmpeg-linux.zip",
      "  Download fallback 1: https://playwright.download.prss.microsoft.com/builds/ffmpeg/1013/ffmpeg-linux.zip",
    ].join("\n");
    expect(parseDryRun(out)).toEqual([
      "https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux64/chrome-headless-shell-linux64.zip",
    ]);
    expect(parseDryRun("something else")).toEqual([]);
  });

  it("resumes a dropped download and retries up to 3 times", async () => {
    const dest = join(tmp(), "shell.zip");
    const starts: number[] = [];
    let call = 0;
    // Each try delivers 4 bytes from where the file stopped, then drops, until it's complete.
    const fetchOnce = async (_url: string, file: string) => {
      const have = existsSync(file) ? readFileSync(file).length : 0;
      starts.push(have);
      appendFileSync(file, "0123456789AB".slice(have, have + 4));
      if (++call < 3) throw new Error("connection reset");
    };
    const logs: string[] = [];
    await downloadResumable(["https://x/a.zip"], dest, { fetchOnce, backoffMs: 0, log: (m) => logs.push(m) });
    expect(starts).toEqual([0, 4, 8]);
    expect(readFileSync(dest, "utf8")).toBe("0123456789AB");
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(logs).toEqual([
      "Download interrupted (connection reset); resuming (try 2 of 3)…",
      "Download interrupted (connection reset); resuming (try 3 of 3)…",
    ]);
  });

  it("gives up after 3 tries, keeping the partial file for the next run", async () => {
    const dest = join(tmp(), "shell.zip");
    let tries = 0;
    const fetchOnce = async (_url: string, file: string) => {
      tries++;
      appendFileSync(file, "x");
      throw new Error("timed out");
    };
    const err = await downloadResumable(["https://x/a.zip"], dest, { fetchOnce, backoffMs: 0, log: () => {} }).catch(
      (e) => e,
    );
    expect(tries).toBe(3);
    expect(err).toBeInstanceOf(BlinkitError);
    expect(err.message).toMatch(/after 3 tries \(timed out\)\nFix: .*`blinkit setup` again/);
    expect(readFileSync(`${dest}.part`, "utf8")).toBe("xxx");
  });
});

describe("doctor", () => {
  const checks: Check[] = [
    { name: "Node.js", ok: true, detail: "v22.22.0" },
    { name: "Browser", ok: false, detail: "no Chromium-based browser found", fix: "run `x`" },
  ];

  it("prints one line per check: ✓, or ✗ with the fix", () => {
    expect(formatChecks(checks)).toBe(
      ["✓ Node.js  v22.22.0", "✗ Browser  no Chromium-based browser found. Fix: run `x`"].join("\n"),
    );
    expect(allOk(checks)).toBe(false);
    expect(allOk(checks.slice(0, 1))).toBe(true);
  });

  const fakes = (amazon: { loggedIn: boolean; whoami?: () => Promise<unknown> }) => ({
    bk: {
      loggedIn: true,
      state: {},
      account: { addresses: async () => [], whoami: () => ({ phone: "******1234" }) },
    } as unknown as Blinkit,
    now: amazon as unknown as AmazonNow,
    nodeVersion: "22.22.0",
    built: () => true,
    locate: () => ({ path: "/usr/bin/chromium", source: "installed" as const, headlessOnly: false }),
    launch: async () => {},
  });

  it("runs every check and says when the address isn't served", async () => {
    const result = await runDoctor(
      fakes({
        loggedIn: true,
        whoami: async () => ({ loggedIn: true, deliverTo: { label: "Home", text: "1 MG Road", serviceable: false } }),
      }),
    );
    expect(formatChecks(result).split("\n")).toEqual([
      "✓ Node.js               v22.22.0",
      "✓ Build                 dist/ is built",
      "✓ Browser               /usr/bin/chromium (installed)",
      "✓ Browser launch        starts headless",
      "✓ Blinkit login         logged in as ******1234",
      "✓ Amazon login          logged in",
      "✓ Amazon address        [Home] 1 MG Road",
      "✗ Amazon Now serves it  no. Fix: your address isn't served by Amazon Now; run `blinkit amazon address` to choose another",
    ]);
  });

  it("fails the checks that can't run, each with a fix", async () => {
    const deps = { ...fakes({ loggedIn: false }), nodeVersion: "20.1.0", locate: () => undefined };
    const result = await runDoctor(deps);
    expect(result.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "Node.js",
      "Browser",
      "Browser launch",
      "Amazon login",
      "Amazon address",
      "Amazon Now serves it",
    ]);
    for (const c of result.filter((x) => !x.ok)) expect(c.fix).toBeTruthy();
    expect(result.find((c) => c.name === "Browser")?.fix).toContain("npx playwright install --only-shell chromium");
  });

  it("gives ✗, never ✓, when BLINKIT_BROWSER points to a missing file", async () => {
    const deps = {
      ...fakes({ loggedIn: false }),
      locate: () => locateBrowser({}, machine({ env: { BLINKIT_BROWSER: "/gone/chrome" } }).sys),
    };
    const lines = formatChecks(await runDoctor(deps)).split("\n");
    expect(lines[2]).toMatch(/^✗ Browser +BLINKIT_BROWSER points to a missing file \(\/gone\/chrome\)\. Fix: set /);
    expect(lines[3]).toMatch(/^✗ Browser launch +skipped/);
  });

  it("says to log in again when the saved Amazon session no longer works", async () => {
    const deps = fakes({
      loggedIn: true,
      whoami: async () => {
        throw new BlinkitError("Amazon didn't return your saved addresses (HTTP 200)");
      },
    });
    const amazon = (await runDoctor(deps)).filter((c) => c.name.startsWith("Amazon"));
    expect(amazon.map((c) => [c.ok, c.fix])).toEqual([
      [false, "log in again: `blinkit amazon login <phone>`"],
      [false, "log in again: `blinkit amazon login <phone>`"],
      [false, "log in again: `blinkit amazon login <phone>`"],
    ]);
  });

  it("reports a browser that is found but won't start", async () => {
    const deps = {
      ...fakes({ loggedIn: false }),
      launch: async () => {
        throw new Error("Failed to launch: missing libnss3.so\nmore detail");
      },
    };
    const launch = (await runDoctor(deps)).find((c) => c.name === "Browser launch");
    expect(launch).toMatchObject({ ok: false, detail: "Failed to launch: missing libnss3.so" });
  });
});

describe("error fixes", () => {
  const fixOf = (message: string) => new BlinkitError(message).message.split("\n").at(-1);

  it("ends every BlinkitError with a Fix: line", () => {
    const e = new BlinkitError("not logged in to Amazon; run `blinkit amazon login <phone>` first");
    expect(e.message).toBe(
      "not logged in to Amazon; run `blinkit amazon login <phone>` first\nFix: run `blinkit amazon login <phone>`",
    );
    expect(e.reason).toBe("not logged in to Amazon; run `blinkit amazon login <phone>` first");
    expect(e.fix).toBe("run `blinkit amazon login <phone>`");
  });

  it("maps messages to the exact command", () => {
    expect(fixOf("Amazon session expired; run `blinkit amazon login <phone>` again")).toBe(
      "Fix: log in again: `blinkit amazon login <phone>`",
    );
    expect(fixOf("Amazon didn't return your saved addresses (HTTP 200)")).toBe(
      "Fix: log in again: `blinkit amazon login <phone>`",
    );
    expect(fixOf('Amazon Now doesn\'t deliver to "Parents"')).toBe(
      "Fix: your address isn't served by Amazon Now; run `blinkit amazon address` to choose another",
    );
    expect(fixOf("session expired or not logged in; run `blinkit login <phone>`")).toBe(
      "Fix: run `blinkit login <phone>`",
    );
    expect(fixOf("no Chromium-based browser found")).toBe(
      "Fix: run `npx playwright install --only-shell chromium`, or set BLINKIT_BROWSER to your Chrome",
    );
    expect(fixOf("cart is empty")).toBe("Fix: add something with `blinkit cart add <productId>`");
    expect(fixOf("the Amazon Now cart is empty")).toBe("Fix: add something with `blinkit amazon cart add <asin>`");
    expect(fixOf("OTP rejected: The code is wrong")).toContain("blinkit amazon login");
    expect(fixOf("amount to pay is ₹120, not ₹100; confirm ₹120 to proceed")).toContain("blinkit checkout");
    expect(fixOf("blinkit.com is refusing automated requests right now (Cloudflare); try again in a few minutes")).toBe(
      "Fix: wait a few minutes, then run the same command again",
    );
  });

  it("falls back to doctor, and lets the throw site override", () => {
    expect(fixFor("something nobody expected")).toBe("run `blinkit doctor` to see what's wrong");
    expect(new BlinkitError("cart is empty", { fix: "do this" }).fix).toBe("do this");
  });

  it("turns Amazon's \"We couldn't send an OTP\" into what to do", () => {
    expect(otpNotSent("sms").reason).toBe("Amazon couldn't send the OTP; wait a few minutes or use --via whatsapp");
    expect(otpNotSent("sms").fix).toBe("wait a few minutes, then run `blinkit amazon login <phone> --via whatsapp`");
    expect(otpNotSent("whatsapp").reason).toBe("Amazon couldn't send the OTP; wait a few minutes or use --via sms");
    expect(fixOf("Amazon: We couldn't send an OTP. Please try again later")).toContain("--via whatsapp");
  });
});
