/**
 * The "Fix:" line every BlinkitError ends with: what to do next, as an exact command where there is one.
 * Rules are tried in order, so the specific ones come first. A throw site can pass its own `fix` instead.
 */

/** The ~100 MB headless-only Chromium (no window), which is all the headless steps need. */
export const INSTALL_BROWSER = "npx playwright install --only-shell chromium";
/** Full Chromium, for the steps that open a window (`blinkit pay --browser`). */
export const INSTALL_HEADED_BROWSER = "npx playwright install chromium";

const AMAZON_LOGIN = "run `blinkit amazon login <phone>`";
const BLINKIT_LOGIN = "run `blinkit login <phone>`";
const AMAZON_ADDRESS = "run `blinkit amazon address` to see your addresses, then `blinkit amazon address use <label>`";
const BLINKIT_ADDRESS = "run `blinkit address list`, then `blinkit address use <label>`";
const RECONFIRM_BLINKIT = "run `blinkit checkout` and pass the amount it shows to `blinkit pay --confirm <rupees>`";
export const RECONFIRM_AMAZON =
  "run `blinkit amazon checkout` and pass the amount it shows to `blinkit amazon pay --confirm <rupees>`";

export const FIX_RULES: [RegExp, string][] = [
  // browser
  [
    /no Chromium-based browser|browser (didn.?t|did not|failed to) (start|launch)/i,
    `run \`${INSTALL_BROWSER}\`, or set BLINKIT_BROWSER to your Chrome`,
  ],
  // Amazon login
  [/couldn.?t send (an|the) OTP/i, "wait a few minutes, then run `blinkit amazon login <phone> --via whatsapp`"],
  [/captcha/i, "wait 15 minutes, then run `blinkit amazon login <phone>` again"],
  [
    /no Amazon account for this number/i,
    "use the mobile number of your Amazon account: `blinkit amazon login <phone>`",
  ],
  [
    /only offered password sign-in/i,
    "turn on OTP sign-in for this account on amazon.in, then run `blinkit amazon login <phone>`",
  ],
  [/^OTP rejected:/i, "enter the newest code again, or run `blinkit amazon login <phone>` for a new one"],
  [
    /not logged in to Amazon|Amazon session expired|no Amazon OTP is waiting|Amazon didn.?t finish the login|Amazon showed an unexpected sign-in|instead of data|^Amazon: /i,
    AMAZON_LOGIN,
  ],
  // Amazon address
  [
    /Amazon Now doesn.?t deliver to|not served by Amazon Now/i,
    "your address isn't served by Amazon Now; run `blinkit amazon address` to choose another",
  ],
  [
    /see `blinkit amazon address`|matches \d+ addresses|say which address|Amazon didn.?t switch|Amazon didn.?t return your saved addresses|token needed to change the address/i,
    AMAZON_ADDRESS,
  ],
  // Amazon catalog, cart and pay
  [/is not an ASIN/i, "use the asin= from `blinkit amazon search <query>`"],
  [
    /Amazon Now doesn.?t sell|has no offer at your address/i,
    "find an alternative with `blinkit amazon search <query>`",
  ],
  [/search needs a query/i, "say what to search for, e.g. `blinkit amazon search milk`"],
  [/the Amazon Now cart is empty/i, "add something with `blinkit amazon cart add <asin>`"],
  [/earlier order that isn.?t settled/i, "wait a few minutes, then run `blinkit amazon checkout` again"],
  [
    /Amazon Pay balance|Amazon reports a problem with this checkout/i,
    "check the cart and bill on amazon.in, then run `blinkit amazon checkout` again",
  ],
  [/Amazon.?s QR is for/i, "don't pay it; check `blinkit amazon orders` (Amazon cancels an unpaid order by itself)"],
  [/rate-limiting/i, "wait a minute, then run the same command again"],
  [
    /Amazon didn.?t (open the payment page|offer "Scan and Pay)|CSRF token|^Amazon \//i,
    "run the same command again; if it keeps failing, run `blinkit doctor`",
  ],
  // Blinkit login
  [/OTP request rejected/i, "wait a minute, then run `blinkit login <phone>` again"],
  [
    /^OTP rejected|invalid otp|incorrect otp/i,
    "run `blinkit verify <code>` with the newest code, or `blinkit login <phone>` for a new one",
  ],
  [/not logged in|needs login|request an OTP first|session has no phone|session expired/i, BLINKIT_LOGIN],
  [/phone must be a 10-digit/i, "pass the 10-digit mobile number without +91, e.g. `blinkit login 98xxxxxxxx`"],
  // Blinkit location and address
  [
    /pincode must be 6 digits|no location found for pincode|could not resolve coordinates/i,
    "pass a 6-digit pincode, e.g. `blinkit location 560034`, or --lat/--lon",
  ],
  [
    /set a delivery location first|no location: pass a pincode/i,
    "run `blinkit location <pincode>` or `blinkit address use <label>`",
  ],
  [/delivery address first|no saved address matches|pay needs login and a saved address/i, BLINKIT_ADDRESS],
  [/ambiguous; use an id/i, "run `blinkit address use <id>` with one of the ids above"],
  [/has no coordinates/i, "save it again with `blinkit address add` and pick it with `blinkit address use <label>`"],
  // Blinkit catalog and cart
  [/ambiguous, pick one|is a group; pick a category/i, "run the command again with one of the names above"],
  [/no category or subcategory matches/i, "run `blinkit categories` to see the names"],
  [/not available at this location|not a product id|quantity for/i, "use a product id from `blinkit search <query>`"],
  [/sort must be one of/i, "use one of the sorts listed above"],
  [/cart is empty/i, "add something with `blinkit cart add <productId>`"],
  [/did not assign a cart id|no server cart id/i, "run `blinkit checkout` first"],
  // Blinkit pay
  [
    /no PAS token/i,
    "wait about 10 minutes for the pending payment to expire, then run `blinkit pay --confirm <rupees>` again",
  ],
  [/blinkit\.com shows ₹|payment hash amount|amount to pay is/i, RECONFIRM_BLINKIT],
  [
    /payment widget|payment QR|makePayment|zomato_payment_hash|createOrder|failed \(HTTP/i,
    "run `blinkit pay --browser --confirm <rupees>` to pay through blinkit.com instead",
  ],
  [/Cloudflare|auth key|non-JSON/i, "wait a few minutes, then run the same command again"],
];

/** The fix for an error message; `blinkit doctor` when nothing more specific applies. */
export function fixFor(message: string): string {
  return FIX_RULES.find(([re]) => re.test(message))?.[1] ?? "run `blinkit doctor` to see what's wrong";
}
