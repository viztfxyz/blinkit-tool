/**
 * Downloads Playwright's headless-only Chromium (`playwright install --only-shell chromium`, ~100 MB)
 * when no browser is installed. Only ever on request (`blinkit setup`, or yes to the CLI's prompt), never
 * in postinstall. The zip is fetched resumably (up to 3 tries, each continuing where the last stopped),
 * then handed to Playwright's own installer through a local mirror so it unpacks and registers it as usual.
 */
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { findBrowser } from "./browser.js";
import { BlinkitError } from "./errors.js";
import { INSTALL_BROWSER } from "./fixes.js";

const DOWNLOADS = join(homedir(), ".cache", "blinkit-tool", "downloads");
const ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Playwright's CLI from our own playwright-core, so the build matches the version that launches it. */
function playwrightCli(): string {
  const pkg = createRequire(import.meta.url).resolve("playwright-core/package.json");
  return join(dirname(pkg), "cli.js");
}

/** The headless shell's download URLs (primary first) from `playwright install --dry-run`. */
export function parseDryRun(out: string): string[] {
  for (const block of out.split(/\r?\n\s*\r?\n/)) {
    const dir = block.match(/Install location:\s*(\S+)/)?.[1];
    if (!dir || !/^chromium/i.test(basename(dir))) continue;
    const urls = [...block.matchAll(/Download (?:url|fallback \d+):\s*(\S+)/g)].map((m) => m[1]);
    if (urls.length) return urls;
  }
  return [];
}

/** Fetch `url` into `file`, continuing from whatever part of it is already there. */
export type ResumableFetch = (url: string, file: string) => Promise<void>;

/** curl resumes (-C -) and honours the system's proxy settings and CA bundle. */
const curlFetch: ResumableFetch = (url, file) =>
  new Promise((resolve, reject) => {
    const args = ["-fL", "-#", "-C", "-", "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "60"];
    const child = spawn("curl", [...args, "-o", file, url], { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`curl exited with ${code}`))));
  });

/** Without curl: a Range request that appends to the partial file. */
const nodeFetch: ResumableFetch = async (url, file) => {
  const have = existsSync(file) ? statSync(file).size : 0;
  const res = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {} });
  if (res.status === 416) return; // already complete
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const append = res.status === 206;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file, { flags: append ? "a" : "w" }));
};

const hasCurl = () => !spawnSync("curl", ["--version"], { stdio: "ignore" }).error;

/**
 * Download to `dest` in up to `attempts` tries. A dropped connection leaves `dest.part` behind and the
 * next try resumes it; `dest` only appears once the download completed.
 */
export async function downloadResumable(
  urls: string[],
  dest: string,
  opts: { fetchOnce?: ResumableFetch; attempts?: number; log?: (m: string) => void; backoffMs?: number } = {},
): Promise<void> {
  const { fetchOnce = hasCurl() ? curlFetch : nodeFetch, attempts = ATTEMPTS, log = console.error } = opts;
  const part = `${dest}.part`;
  mkdirSync(dirname(dest), { recursive: true });
  let last = "";
  for (let i = 0; i < attempts; i++) {
    try {
      await fetchOnce(urls[i % urls.length], part);
      renameSync(part, dest);
      return;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      if (i + 1 < attempts) {
        log(`Download interrupted (${last}); resuming (try ${i + 2} of ${attempts})…`);
        await sleep((opts.backoffMs ?? 2000) * (i + 1));
      }
    }
  }
  throw new BlinkitError(`couldn't download the browser after ${attempts} tries (${last})`, {
    fix: "check your internet connection, then run `blinkit setup` again; it resumes the download",
  });
}

function runPlaywright(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli(), ...args], { stdio: ["ignore", "inherit", "inherit"], env });
    child.on("error", reject);
    child.on("exit", resolve);
  });
}

/** Serve one file at every path, so Playwright's installer can "download" it from localhost. */
async function serveFile(file: string): Promise<{ host: string; close: () => void }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/zip", "content-length": statSync(file).size });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { host: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Download and install the headless shell into Playwright's cache. */
export async function installBrowser(log: (m: string) => void = console.error): Promise<void> {
  const install = ["install", "--only-shell", "chromium"];
  const dry = spawnSync(process.execPath, [playwrightCli(), ...install, "--dry-run"], { encoding: "utf8" });
  const urls = parseDryRun(dry.stdout ?? "");
  if (!urls.length) {
    // Unknown dry-run format: let Playwright download it itself (no resume), still retrying.
    for (let i = 0; i < ATTEMPTS; i++) if ((await runPlaywright(install)) === 0 || findBrowser()) return;
    throw new BlinkitError(`couldn't download the browser after ${ATTEMPTS} tries`, {
      fix: `check your internet connection, then run \`${INSTALL_BROWSER}\``,
    });
  }
  const zip = join(DOWNLOADS, basename(new URL(urls[0]).pathname));
  if (!existsSync(zip)) {
    log(`Downloading Chromium headless shell from ${new URL(urls[0]).host}…`);
    await downloadResumable(urls, zip, { log });
  }
  const mirror = await serveFile(zip);
  try {
    const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, "127.0.0.1"].filter(Boolean).join(",");
    const env = {
      ...process.env,
      PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST: mirror.host,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    };
    const code = await runPlaywright(install, env);
    // Playwright also fetches ffmpeg, which we don't use: the browser itself is what counts.
    if (code !== 0 && !findBrowser()) {
      rmSync(zip, { force: true }); // maybe corrupt; the next run downloads it again
      throw new BlinkitError("Playwright couldn't install the downloaded browser", {
        fix: "run `blinkit setup` again",
      });
    }
  } finally {
    mirror.close();
  }
  rmSync(zip, { force: true });
}
