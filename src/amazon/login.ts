/**
 * Amazon login by OTP, in headless Chromium. Amazon's sign-in screens (passkey prompt, "sign in
 * another way", WhatsApp/SMS OTP) only exist as pages, so the browser stays open between sending the
 * OTP and verifying it: both steps must run in the same process (interactive CLI, or the MCP server).
 */
import type { Page } from "playwright-core";
import { BlinkitError } from "../core/errors.js";
import { maskPhone } from "../services/parsing.js";
import { type NowBrowser, openBrowser, pageText, snapshot } from "./browser.js";
import { AUTH_COOKIE, NOW_HOME, NOW_SIGNIN } from "./config.js";
import type { NowSession } from "./session.js";

export type OtpChannel = "sms" | "whatsapp";
export const OTP_CHANNELS = ["sms", "whatsapp"] as const satisfies readonly OtpChannel[];

/** Where the OTP screen says the code went; "unknown" when it doesn't say. */
export function otpSentVia(text: string): OtpChannel | "unknown" {
  // Drop "get OTP on WhatsApp instead"-style offers so only the "we've sent…" sentence decides.
  text = text.replace(
    /(get|send|receive|resend)\s+(an?\s+)?(otp|code)\s+(on|via|by|through)\s+(whatsapp|sms|text message)(\s+instead)?/gi,
    " ",
  );
  if (/Verify with SMS/i.test(text)) return "sms";
  if (/Verify with WhatsApp/i.test(text)) return "whatsapp";
  if (/sent.{0,60}WhatsApp|WhatsApp.{0,40}(code|OTP)|Verify with WhatsApp/i.test(text)) return "whatsapp";
  if (/sent.{0,60}(SMS|text message|mobile number|phone|\+\d)|\bSMS\b.{0,40}(code|OTP)/i.test(text)) return "sms";
  return "unknown";
}

/** Whether the OTP screen says the code was sent, and where. */
export function otpOutcome(text: string): { otpSent: boolean; channel: OtpChannel | "unknown" } {
  return { otpSent: !/couldn.?t send an OTP|unable to send|try again later/i.test(text), channel: otpSentVia(text) };
}

const OTP_INPUT = "#ap_otp_code, input[name=otpCode], #cvf-input-code, input[name=code]";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function visible(page: Page, selector: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

/** Click and wait for whatever navigation it triggers to settle. */
async function clickAndSettle(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    target.click({ timeout: 10000 }),
  ]);
  await sleep(2500);
}

export class NowLogin {
  private pending?: { b: NowBrowser; phone: string };

  constructor(private session: NowSession) {}

  /** Send a login OTP to the Amazon account's mobile number (SMS by default). */
  async requestOtp(phone: string, channel: OtpChannel = "sms") {
    const digits = String(phone).replace(/\D/g, "").slice(-10);
    if (!/^[6-9]\d{9}$/.test(digits)) throw new BlinkitError("phone must be a 10-digit Indian mobile number");
    await this.cancel();
    const b = await openBrowser(this.session, { fresh: true });
    try {
      const { page } = b;
      await page.goto(NOW_SIGNIN, { waitUntil: "domcontentloaded" });
      const id = page.locator("#ap_email_login, #ap_email").first();
      await id.waitFor({ state: "visible", timeout: 20000 });
      await id.click();
      await id.fill("");
      await id.pressSequentially(`+91${digits}`, { delay: 80 });
      // Amazon's unified claim page (/ax/claim) leaves the hidden countryCode empty when headless; set it so the number validates.
      await page
        .evaluate(() => {
          const cc = document.querySelector<HTMLInputElement>("input[name=countryCode]");
          if (cc && !cc.value) cc.value = "IN";
        })
        .catch(() => undefined);
      await id.blur();
      await sleep(800);
      await clickAndSettle(page, page.locator("input#continue, input[type=submit]").first());
      await this.reachOtp(page, channel);
      const r = otpOutcome(await pageText(page));
      if (!r.otpSent) {
        await b.discard();
        return { ...r, error: "Amazon couldn't send the OTP", to: maskPhone(digits) };
      }
      this.pending = { b, phone: digits };
      return { ...r, to: maskPhone(digits) };
    } catch (e) {
      await b.discard();
      throw e;
    }
  }

  /** Walk from the screen after the phone number to the OTP entry form, asking for an OTP on the way. */
  private async reachOtp(page: Page, channel: OtpChannel): Promise<void> {
    let switched = false; // switch channel at most once, so a missed switch can't keep sending codes
    for (let step = 0; step < 6; step++) {
      const text = await pageText(page);
      if (await visible(page, OTP_INPUT)) {
        const sentVia = otpSentVia(text);
        const wrong = channel === "sms" ? /WhatsApp/i.test(text) && sentVia !== "sms" : sentVia !== "whatsapp";
        const other = page
          .locator("a, button, span[role=button]")
          .filter({ hasText: channel === "sms" ? /\b(SMS|text message)\b/i : /\bWhatsApp\b/i })
          .filter({ visible: true });
        if (!switched && wrong && (await other.count())) {
          switched = true;
          await clickAndSettle(page, other.first());
          continue;
        }
        return;
      }
      if (await visible(page, "#captchacharacters, img[src*='captcha' i]")) {
        throw new BlinkitError(
          `Amazon wants a captcha before sending the OTP; try again later (${await snapshot(page)})`,
        );
      }
      if (
        /looks like you.?re new to Amazon|no account found|cannot find an account/i.test(text) ||
        page.url().includes("/ap/register")
      ) {
        throw new BlinkitError("there is no Amazon account for this number");
      }
      // "Use your passkey" → the full list of sign-in methods. Headless Chromium has no passkey, so
      // Amazon may also show "Passkey error… sign in another way" here; that is expected, not fatal.
      const more = await page
        .locator("a.ax-challenge-more")
        .first()
        .getAttribute("href")
        .catch(() => null);
      if (more && !page.url().includes("showOtherChallenges=true")) {
        await page.goto(new URL(more, page.url()).href, { waitUntil: "domcontentloaded" });
        await sleep(2000);
        continue;
      }
      // Method list, or a password page offering an OTP instead.
      const otp = page.getByText(/Send OTP|Get an OTP|Sign in with OTP|one time password/i).filter({ visible: true });
      if (await otp.count()) {
        await clickAndSettle(page, otp.first());
        continue;
      }
      const errors = page
        .locator("#auth-error-message-box, .a-alert-error, .a-alert-inline-error")
        .filter({ visible: true });
      const error = (await errors.allInnerTexts().catch(() => [])).join(" ").replace(/\s+/g, " ").trim();
      if (error && !/passkey/i.test(error)) throw new BlinkitError(`Amazon: ${error}`);
      if (await visible(page, "#ap_password")) {
        throw new BlinkitError("Amazon only offered password sign-in for this account; OTP login isn't available");
      }
      break;
    }
    throw new BlinkitError(`Amazon showed an unexpected sign-in screen (${await snapshot(page)})`);
  }

  /** Finish login with the OTP. The session cookies are saved for HTTP use. */
  async verifyOtp(code: string) {
    const p = this.pending;
    if (!p) {
      throw new BlinkitError(
        "no Amazon OTP is waiting in this session; request one first (`blinkit amazon login <phone>` prompts for it)",
      );
    }
    const { page, context } = p.b;
    const otp = String(code).replace(/\s/g, "");
    if (!/^\d{4,8}$/.test(otp)) throw new BlinkitError("OTP should be 4–8 digits");
    await page.locator(OTP_INPUT).first().fill(otp);
    await clickAndSettle(page, page.locator("#cvf-submit-otp-button input, input[type=submit]").first());
    for (let i = 0; i < 20; i++) {
      if ((await context.cookies()).some((c) => c.name === AUTH_COOKIE && c.value)) {
        await page.goto(NOW_HOME, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        await sleep(3000);
        await p.b.close();
        this.pending = undefined;
        return { loggedIn: true as const, phone: maskPhone(p.phone) };
      }
      if (await visible(page, OTP_INPUT)) {
        const msg = await page
          .locator(".a-alert-error, #auth-error-message-box, .cvf-widget-alert")
          .first()
          .innerText()
          .catch(() => "");
        if (msg.trim()) throw new BlinkitError(`OTP rejected: ${msg.replace(/\s+/g, " ").trim()}`);
      }
      await sleep(1000);
    }
    throw new BlinkitError(`Amazon didn't finish the login after the OTP (${await snapshot(page)})`);
  }

  async cancel(): Promise<void> {
    const p = this.pending;
    this.pending = undefined;
    if (p) await p.b.discard();
  }
}
