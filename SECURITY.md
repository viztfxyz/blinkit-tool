# Security Policy

handcart handles login tokens and starts real UPI payments, so security reports are taken seriously.

## Supported versions

Only the latest release gets fixes.

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately through
[GitHub security advisories](https://github.com/viztfxyz/handcart/security/advisories/new) instead.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a
week. Once it's fixed and released, you'll be credited in the advisory unless you'd rather not be.

## In scope

- Leaking the session file, access tokens or OTPs (to disk with loose permissions, to logs, to third parties)
- A payment going through for an amount the user didn't confirm, or a second payment for one order
- The MCP server doing something with money or account data beyond what a tool's description says

## Out of scope

- Bugs in Blinkit, Zomato, Zepto or qrbaton themselves (report those to them)
- Blinkit or Zepto blocking or rate-limiting automated access
- Anyone with a qrbaton pay link being able to see that order's details: that's how pay links work; use
  `--handoff qr` to avoid it

## Keeping your account safe

- Your session lives in `~/.config/handcart/` (readable only by you). Treat it like a password.
- Run `handcart blinkit logout` and `handcart zepto logout` on shared machines.
- Only give the MCP server to agents you trust to spend money on your behalf, and always check the amount before
  confirming a payment.
