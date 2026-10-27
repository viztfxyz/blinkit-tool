import { BlinkitError } from "../core/errors.js";

export const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

/** CLI commands in a fix, and the tool calls an agent makes instead. More specific commands first. */
const TOOL_FOR: [RegExp, string][] = [
  [
    /`blinkit amazon login <phone> --via (\w+)`/g,
    '`amazon_now_login_request_otp` with via: "$1" (the user\'s phone), then `amazon_now_login_verify_otp`',
  ],
  [
    /`blinkit amazon login[^`]*`/g,
    "`amazon_now_login_request_otp` (the user's phone), then `amazon_now_login_verify_otp`",
  ],
  [/`blinkit amazon address use[^`]*`/g, "`amazon_now_use_address`"],
  [/`blinkit amazon address`/g, "`amazon_now_addresses`"],
  [/`blinkit amazon search[^`]*`/g, "`amazon_now_search`"],
  [/`blinkit amazon cart add[^`]*`/g, "`amazon_now_cart_set`"],
  [/`blinkit amazon checkout`/g, "`amazon_now_checkout`"],
  [/`blinkit amazon pay[^`]*`/g, "`amazon_now_pay` (after the user confirms the amount)"],
  [/`blinkit amazon orders`/g, "`amazon_now_orders`"],
  [/`blinkit login[^`]*`/g, "`blinkit_login_request_otp` (the user's phone), then `blinkit_login_verify_otp`"],
  [/`blinkit verify[^`]*`/g, "`blinkit_login_verify_otp`"],
  [/`blinkit address use[^`]*`/g, "`blinkit_use_address`"],
  [/`blinkit address list`/g, "`blinkit_addresses`"],
  [/`blinkit address add`/g, "`blinkit_add_address`"],
  [/`blinkit location[^`]*`/g, "`blinkit_set_location`"],
  [/`blinkit search[^`]*`/g, "`blinkit_search`"],
  [/`blinkit categories`/g, "`blinkit_categories`"],
  [/`blinkit cart add[^`]*`/g, "`blinkit_cart_set`"],
  [/`blinkit cart`/g, "`blinkit_cart`"],
  [/`blinkit checkout`/g, "`blinkit_checkout`"],
  [/`blinkit pay[^`]*`/g, "`blinkit_pay` (after the user confirms the amount)"],
  [/`blinkit doctor`/g, "`doctor`"],
];

/** A fix as an agent should act on it: tool calls where there are tools; other commands (installs) stay. */
export function toolFix(fix: string): string {
  return TOOL_FOR.reduce((s, [re, tool]) => s.replace(re, tool), fix).replace(/\brun `(\w+)`/g, "call `$1`");
}

/** Wrap a handler so BlinkitErrors come back as tool errors the agent can read. */
export const tool =
  <A>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      const text =
        e instanceof BlinkitError
          ? `${toolFix(e.reason)}\nFix: ${toolFix(e.fix)}`
          : `unexpected error: ${(e as Error).message}`;
      return { content: [{ type: "text" as const, text }], isError: true };
    }
  };
