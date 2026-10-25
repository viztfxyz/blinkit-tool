/**
 * Fallback (and `--browser`): drive blinkit.com in a local Chromium via Playwright to the UPI step,
 * read the QR from the zpaykit frame, and hand it off the same way as the API path.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Blinkit } from "../client.js";
import { BASE, paths } from "../core/config.js";
import { BlinkitError } from "../core/errors.js";
import { confirmedCheckout, type PayOptions, PayRun } from "./flow.js";
import { type FrameQrCapture, upiIntentFromCapture } from "./qr.js";
import type { PayStatus } from "./status.js";

/** Skip Homebrew-style wrappers whose `exec` target is missing (e.g. chromium → Chromium.app). */
function isRunnableBrowser(bin: string): boolean {
  if (!existsSync(bin)) return false;
  try {
    const head = readFileSync(bin, "utf8").slice(0, 400);
    if (!head.startsWith("#!")) return true;
    const m = head.match(/\bexec\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
    const target = m?.[1] ?? m?.[2] ?? m?.[3];
    return !target || existsSync(target);
  } catch {
    return true; // binary, not a script
  }
}

function findBrowser(): string | undefined {
  if (process.env.BLINKIT_BROWSER) return process.env.BLINKIT_BROWSER;
  const mac = ["Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge", "Arc"].map(
    (app) => `/Applications/${app}.app/Contents/MacOS/${app}`,
  );
  const win = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
    .filter((dir): dir is string => !!dir)
    .flatMap((dir) => [
      join(dir, "Google/Chrome/Application/chrome.exe"),
      join(dir, "Microsoft/Edge/Application/msedge.exe"),
    ]);
  const fixed = [...mac, ...win].find(isRunnableBrowser);
  if (fixed) return fixed;
  const names = [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "brave",
    "microsoft-edge",
  ];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const n of names) {
      const p = join(dir, n);
      if (isRunnableBrowser(p)) return p;
    }
  }
  return undefined;
}

/** On Linux, run Chromium on X11 (XWayland on Wayland desktops): Playwright + Wayland can hang. */
function displayEnv(): { env: Record<string, string>; args: string[] } {
  const env = { ...process.env } as Record<string, string>;
  if (process.platform !== "linux") return { env, args: [] };
  env.DISPLAY ||= ":0";
  if (!env.XAUTHORITY) {
    const runDir = `/run/user/${process.getuid?.() ?? 1000}`;
    const xauth = existsSync(runDir) ? readdirSync(runDir).find((f) => f.startsWith("xauth_")) : undefined;
    const candidate = xauth ? join(runDir, xauth) : join(homedir(), ".Xauthority");
    if (existsSync(candidate)) env.XAUTHORITY = candidate;
  }
  return { env, args: ["--ozone-platform=x11"] };
}

/**
 * Serialized into the zpaykit frame by Playwright. Must not close over Node state.
 * Reads a upi:// string, or PNG bytes from a QR canvas/img, out of the document.
 */
function probeZpaykitQr(): FrameQrCapture {
  // biome-ignore lint/performance/useDomNodeTextContent: the rendered text is what holds the UPI string
  const text = [document.documentElement?.innerHTML ?? "", document.body?.innerText ?? ""].join("\n");
  const pngs: string[] = [];
  const seen = new Set<string>();
  const push = (b64: string | null) => {
    if (!b64 || b64.length < 200 || b64.length > 2_000_000 || seen.has(b64) || pngs.length >= 4) return;
    seen.add(b64);
    pngs.push(b64);
  };
  const canvasPng = (canvas: HTMLCanvasElement): string | null => {
    const w = canvas.width;
    const h = canvas.height;
    if (w < 48 || h < 48 || w > 800 || h > 800) return null;
    try {
      const url = canvas.toDataURL("image/png");
      const comma = url.indexOf(",");
      if (!url.startsWith("data:image/png") || comma < 0) return null;
      return url.slice(comma + 1);
    } catch {
      return null;
    }
  };
  const imgPng = (img: HTMLImageElement): string | null => {
    const src = img.currentSrc || img.src || "";
    if (src.startsWith("data:image/png")) {
      const comma = src.indexOf(",");
      return comma >= 0 ? src.slice(comma + 1) : null;
    }
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < 48 || h < 48 || w > 800 || h > 800) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0);
      return canvasPng(canvas);
    } catch {
      return null;
    }
  };
  const labelOf = (el: Element) =>
    [
      el.id,
      el.getAttribute("class"),
      el.getAttribute("alt"),
      el.getAttribute("src"),
      el.getAttribute("aria-label"),
    ].join(" ");
  const nodes = Array.from(document.querySelectorAll("canvas, img"));
  nodes.sort((a, b) => Number(/qr/i.test(labelOf(b))) - Number(/qr/i.test(labelOf(a))));
  for (const node of nodes) {
    if (node instanceof HTMLCanvasElement) push(canvasPng(node));
    else if (node instanceof HTMLImageElement) push(imgPng(node));
    if (pngs.length >= 4) break;
  }
  return { text, pngs };
}

export async function payViaBrowser(bk: Blinkit, opts: PayOptions, apiError?: string): Promise<PayStatus> {
  const cart = await confirmedCheckout(bk, opts.confirmAmount);
  const toPay = cart.bill.toPay;
  const { state } = bk;
  const a = state.address;
  const accessToken = state.accessToken;
  if (!a || !accessToken) throw new BlinkitError("pay needs login and a saved address");
  const executablePath = findBrowser();
  if (!executablePath) throw new BlinkitError("no Chromium-based browser found; install one or set BLINKIT_BROWSER");
  const { chromium } = await import("playwright-core");
  const run = new PayRun(bk, opts, toPay, apiError);
  const { log } = run;

  // What blinkit.com keeps in localStorage for a logged-in session with this cart and address.
  const storage = {
    auth: { accessToken: state.accessToken, phoneNumber: state.user?.phone },
    user: { id: state.user?.id, phone: state.user?.phone, verified: true },
    location: {
      coords: {
        lat: a.lat,
        lon: a.lon,
        locality: a.label,
        landmark: a.text,
        addressId: a.id,
        isDefault: false,
        id: a.label,
      },
    },
    cart: {
      count: cart.items.reduce((n, i) => n + i.quantity, 0),
      total: cart.bill.itemsTotal,
      items: Object.fromEntries(
        cart.items.map((i) => [
          String(i.productId),
          {
            product: {
              product_id: i.productId,
              price: i.price,
              image_url: null,
              name: i.name,
              unit: i.unit,
              mrp: i.mrp,
              group_id: null,
            },
            quantity: i.quantity,
          },
        ]),
      ),
      promoInfo: [],
      paymentMode: null,
      step: [],
      version: 1,
      promo_id: "",
    },
  };

  const { env, args } = displayEnv();
  run.status("launching");
  const browser = await chromium.launch({ executablePath, headless: false, args, env, timeout: 60000 });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  mkdirSync(dirname(paths.qrRaw), { recursive: true });
  try {
    await page.context().addCookies([{ name: "accessToken", value: accessToken, domain: "blinkit.com", path: "/" }]);
    await page.goto(`${BASE}/robots.txt`);
    await page.evaluate(
      ([ls, deviceId]) => {
        for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, JSON.stringify(v));
        localStorage.setItem("deviceId", deviceId);
      },
      [storage, state.deviceId] as const,
    );
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction("window.__reduxStore__", undefined, { timeout: 60000 });
    await page.waitForTimeout(3000);

    log("Opening cart…");
    const cartButton = page.locator("text=/\\d+ items?/").first();
    try {
      await cartButton.waitFor({ timeout: 30000 });
    } catch {
      await page.reload({ waitUntil: "domcontentloaded" });
      await cartButton.waitFor({ timeout: 30000 });
    }
    await cartButton.click();
    const proceed = page.getByText("Proceed To Pay");
    await proceed.first().waitFor({ timeout: 30000 });
    // biome-ignore lint/performance/useDomNodeTextContent: the total is matched against the text as rendered
    const body = await page.evaluate(() => document.body.innerText);
    const m = body.match(/Grand total\s*₹\s*([\d,]+)/);
    const siteTotal = m ? Number(m[1].replace(/,/g, "")) : undefined;
    if (siteTotal !== Math.round(toPay)) {
      throw new BlinkitError(`blinkit.com shows ₹${siteTotal ?? "?"} but you confirmed ₹${toPay}; aborting`);
    }
    await proceed.last().click();

    log("Opening UPI payment…");
    await page.waitForURL("**/checkout**", { timeout: 30000 });
    let frame = page.frames().find((f) => f.url().includes("zpaykit"));
    for (let i = 0; i < 60; i++) {
      frame = page.frames().find((f) => f.url().includes("zpaykit"));
      if (frame && (await frame.getByText("UPI", { exact: true }).count())) break;
      await page.waitForTimeout(500);
    }
    if (!frame) throw new BlinkitError("payment widget did not load");
    await frame.getByText("UPI", { exact: true }).first().click();

    if (opts.dryRun) {
      await page.waitForTimeout(2000);
      await page.screenshot({ path: paths.dryRunShot });
      log(`Dry run: reached the UPI payment step for ₹${toPay} without generating a QR (${paths.dryRunShot}).`);
      return run.status("dry_run_ok", { screenshot: paths.dryRunShot });
    }

    await frame.getByText("Generate QR").first().click();
    await page.waitForTimeout(4000);
    const qrEl = frame.locator("canvas, img[src*='qr'], img[alt*='QR' i], [class*='qr' i] img").first();
    try {
      await qrEl.waitFor({ state: "visible", timeout: 8000 });
      await qrEl.screenshot({ path: paths.qrRaw });
    } catch {
      await page.screenshot({ path: paths.qrRaw });
    }
    const capture = await frame.evaluate(probeZpaykitQr).catch(() => null);
    const shot = existsSync(paths.qrRaw) ? readFileSync(paths.qrRaw) : undefined;
    const upiIntent = upiIntentFromCapture(capture, shot);
    if (!upiIntent && !shot) throw new BlinkitError("could not capture the payment QR");
    // Without a decoded intent, qrbaton reads the captured image itself.
    await run.ready({ cart, upiIntent, qrPng: upiIntent ? undefined : shot });

    const deadline = Date.now() + (opts.timeoutSec ?? 600) * 1000;
    while (Date.now() < deadline) {
      if (page.isClosed()) return run.finish("browser_closed");
      const url = page.url();
      if (url.includes("/checkout/failure")) return run.finish("failed", { url });
      if (!url.includes("/checkout") || url.includes("success")) {
        await page.waitForTimeout(3000);
        return run.finish("paid", { url: page.url() });
      }
      await page.waitForTimeout(1500);
    }
    return run.finish("timeout");
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    await page.screenshot({ path: paths.payErrorShot }).catch(() => undefined);
    await run.finish("error", { error: msg, screenshot: paths.payErrorShot });
    throw new BlinkitError(`${msg} (screenshot: ${paths.payErrorShot})`);
  } finally {
    await page.waitForTimeout(2000).catch(() => undefined);
    await browser.close();
  }
}
