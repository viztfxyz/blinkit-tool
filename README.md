# blinkit-tool

[![CI](https://github.com/viztfxyz/blinkit-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/viztfxyz/blinkit-tool/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/blinkit-tool)](https://www.npmjs.com/package/blinkit-tool)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Unofficial [Blinkit](https://blinkit.com) client: search, browse, cart, checkout and UPI pay, as a **CLI**, a
**TypeScript library**, and an **MCP server** for Claude, Cursor and other agents.

## Quick start

```bash
npm install -g blinkit-tool
blinkit setup
blinkit doctor
```

> [!WARNING]
> Not affiliated with, endorsed by, or supported by Blinkit or Zomato. It talks to the same private
> endpoints blinkit.com uses, which can change or break at any time, and automated use may be against
> their terms. Use it for your own account, at your own risk. Real orders and real money are involved:
> `pay` only proceeds when you pass the exact amount `checkout` showed.

## CLI

```bash
blinkit location 560034                       # browse without login (indicative prices)
blinkit search paneer --in-stock
blinkit search "pears soap" --out-of-stock    # also list sold-out items
blinkit browse "Bathing Soaps" --sort price
blinkit product 211410

blinkit login 98xxxxxxxx                      # SMS OTP
blinkit address list
blinkit address use home                      # label, id, or part of the address
blinkit cart add 211410 -q 2
blinkit checkout                              # payable bill for that address
blinkit pay --confirm 642                     # the exact amount checkout showed
```

Every listing command takes `--json`. Run `blinkit <command> --help` for all options.

### Sold-out products

Blinkit's search never returns sold-out products, and category listings put them at the very end, so by default
you mostly see what's in stock. Pass `--out-of-stock` (`-o`) to `search` or `browse` (MCP: `includeOutOfStock: true`)
to also list sold-out items, tagged `[OUT OF STOCK]` / `inStock: false`, after the in-stock ones. For search this
looks up the categories the top results belong to and pages their listings, so it takes a few extra seconds.
`blinkit product <id>` works for sold-out products too.

### Paying

Payment is headless (Blinkit → Zomato zpaykit, no browser needed). The UPI QR is handed to whoever pays either as a
[qrbaton](https://qrbaton.vercel.app) pay page (items, bill, delivery address, one-tap GPay / PhonePe / Paytm) or
as a plain QR image.

`blinkit pay --confirm <rupees>` places the order and waits for the UPI payment (10 minutes by default). How the
QR reaches the payer is set with `--handoff`:

| `--handoff`         | What you get                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qrbaton` (default) | A [qrbaton](https://qrbaton.vercel.app) link. The page shows the items, bill and delivery address; the payer taps Pay to open their UPI app, and the page updates when the payment completes. No account or API key. |
| `qr`                | Just the UPI QR as a PNG (and the `upi://` link). Nothing leaves your machine except the payment itself.                                                                                                             |

If qrbaton can't be reached, `pay` falls back to the plain QR and says so. The QR PNG is always saved to
`~/.cache/blinkit-tool/upi_qr.png`.

Other options: `--no-open` prints the link / QR path instead of opening it, `--agent <name>` shows who prepared the
order on the pay page, `--browser` drives blinkit.com in Chromium instead of the API, `--dry-run` stops before a QR
is generated.

> qrbaton never handles money, but anyone with a pay link can see the order, including the delivery address.
> Use `--handoff qr` if you don't want that.

## MCP server (Claude, Cursor, Grok…)

Add the stdio server to your client. `npx` downloads and runs the latest version, nothing to install first:

```json
{
  "mcpServers": {
    "blinkit": {
      "command": "npx",
      "args": ["-y", "blinkit-tool", "mcp"]
    }
  }
}
```

- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart Claude
- **Claude Code**: `claude mcp add blinkit -- npx -y blinkit-tool mcp`
- **Cursor**: `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)
- **Grok CLI**: `grok mcp add blinkit -- npx -y blinkit-tool mcp`

Run `npx blinkit-tool setup` once from a terminal, or let the agent log in with the OTP tools. Agents call the
`doctor` tool first to see what's missing.

The server runs on your machine, so cloud-only agents can't reach it.

### Agent flow

`blinkit_session` → (login: `blinkit_login_request_otp`, `blinkit_login_verify_otp`) → `blinkit_use_address` →
`blinkit_search` / `blinkit_browse` → `blinkit_cart_set` → `blinkit_checkout` → **user confirms the amount** →
`blinkit_pay` → poll `blinkit_pay_status` until `qr_ready` → send the user `payLink` (or, with `handoff: "qr"`, the QR
image attached to the status result).

The server's instructions tell agents never to request an OTP for a number the user didn't give, and never to call
`blinkit_pay` without explicit confirmation of the exact amount.

## Amazon Now

The same CLI also drives [Amazon Now](https://www.amazon.in) (Amazon's 10-minute delivery in India) under
`blinkit amazon`, and the MCP server exposes it as `amazon_now_*` tools.

```bash
blinkit amazon login 98xxxxxxxx           # OTP by SMS (--via whatsapp also works)
blinkit amazon address                    # saved addresses; * = in use
blinkit amazon address use home           # label, id, or part of the address
blinkit amazon search "amul milk" --in-stock
blinkit amazon cart add B018E0HQPE -q 2   # products are ASINs
blinkit amazon checkout                   # payable bill for your selected Amazon address
blinkit amazon pay --confirm 106          # the exact amount checkout showed
blinkit amazon orders                     # delivery and payment state
```

- **Works on a headless server.** Amazon's sign-in and payment pages need a real browser, so `login` and `pay` run
  Chromium headless; everything else is plain HTTP. If no browser is installed, `blinkit setup` offers to download
  Playwright's Chromium.
- **"Amazon couldn't send the OTP"**: wait a few minutes, or use the other channel (`--via whatsapp` / `--via sms`).
- **Login runs in one process.** `blinkit amazon login` waits for the OTP at a prompt; over MCP the server keeps the
  sign-in open between `amazon_now_login_request_otp` and `amazon_now_login_verify_otp`.
- **Pay is UPI QR only and never uses Amazon Pay balance.** Amazon pre-selects your balance on its payment page;
  `pay` picks "Scan and Pay with UPI" and refuses to press Pay unless that is the only selection, the total is the
  amount you confirmed, and the bill shows no balance applied. The QR is a normal merchant UPI QR (it checks the
  amount inside it) handed over like Blinkit's: a qrbaton pay link or, with `--handoff qr`, the image.
- Pressing Pay places the order. The QR carries its own expiry (about 10 minutes so far), which `pay` reads and
  reports as `qrExpiresAt`; if nobody pays by then, Amazon cancels the order.
  Use `--dry-run` to stop on the payment page with UPI selected, before the order is placed.
- Delivery goes to the saved address in use (`blinkit amazon address`). Only addresses Amazon Now serves can be
  picked; prices and stock can change with the address, so check `checkout` again after switching.

The session is a cookie file at `~/.config/blinkit-tool/amazon-now.cookies` (`AMAZON_NOW_COOKIES` to override),
readable only by you. Treat it like a password.

## Library

```ts
import { Blinkit, payWithUpi } from "blinkit-tool";

const bk = new Blinkit(); // session at ~/.config/blinkit-tool/session.json, or pass a path
await bk.setLocation({ pincode: "560034" });
const milk = await bk.catalog.search("milk", { sort: "price", inStock: true, limit: 5 });
await bk.cart.add(milk[0].productId, 2);
console.log((await bk.cart.get()).bill.toPay);

// Login: bk.account.requestOtp(phone), then bk.account.verifyOtp(code).
// Pay:   await payWithUpi(bk, { confirmAmount: 642, handoff: "qr", openPage: false });
```

## Install and requirements

- Node.js ≥ 22
- A Chromium-based browser for Amazon Now login and pay, and for Blinkit's `pay --browser`. It is found
  automatically (`BLINKIT_BROWSER`, Playwright's Chromium, then Chrome, Edge, Brave or Chromium). If there is none,
  `blinkit setup` asks before running `npx playwright install chromium`. Nothing is downloaded when you install
  the package.

```bash
npm install -g blinkit-tool       # gives you the `blinkit` command
npx blinkit-tool search milk -p 560034   # or run it without installing
```

As a library in your own project: `npm install blinkit-tool`. To hack on it, see [CONTRIBUTING.md](CONTRIBUTING.md).

### `blinkit setup` and `blinkit doctor`

`blinkit setup` walks through everything once: it finds (or offers to download) the browser, logs in to Blinkit and Amazon
(phone number and OTP; it tells you whether Amazon sent the code by SMS or WhatsApp), picks the delivery addresses,
runs `doctor` and ends with "Ready". Run it again any time: finished steps are skipped. It only sends an OTP to a
number you type, and only downloads after you answer `y`; without a terminal (piped or in a script) it logs in to
nothing, downloads nothing, and just prints doctor's checks with their fixes.

`blinkit doctor` prints one line per check (the browser is found and starts, Blinkit login, Amazon login with an
address Amazon Now serves), ✓ or ✗ with the command that fixes it, and exits non-zero if anything
is ✗. Agents get the same as the MCP tool `doctor`.

## Configuration

| Variable             | Purpose                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `BLINKIT_SESSION`    | Session file (default `~/.config/blinkit-tool/session.json`, owner-readable only) |
| `BLINKIT_BROWSER`    | Chromium-based browser to use (found automatically otherwise)                     |
| `QRBATON_URL`        | qrbaton host, if you run your own (default `https://qrbaton.vercel.app`)          |
| `AMAZON_NOW_COOKIES` | Amazon Now session file (default `~/.config/blinkit-tool/amazon-now.cookies`)     |

Caches (pincode lookups, category tree, last pay status, QR image) live in `~/.cache/blinkit-tool/`.

## Troubleshooting

Run `blinkit doctor` first: it names the command that fixes each problem.

- **"blinkit.com is refusing automated requests"**: Cloudflare is challenging the request. Wait a few minutes and retry.
- **"session expired or not logged in"**: run `blinkit login <phone>` again.
- **Search doesn't show something you expected**: it may be sold out; retry with `--out-of-stock`.
- **`pay` says the amount differs**: the bill changed (stock, charges, promo). Run `blinkit checkout` and confirm the new amount.
- **"createOrder returned no PAS token"**: the cart has a pending payment. Wait for it to expire (about 10 minutes) and retry.

## Project layout

```
src/
  bin/        CLI and MCP entry points
  cli/        commander commands and terminal formatting
  mcp/        MCP tool definitions
  client.ts   Blinkit: the public client (session + catalog, cart, account)
  doctor.ts   the checks behind `blinkit doctor` and the MCP tool `doctor`
  core/       config, HTTP transport (Chrome TLS impersonation), session, storage, errors,
              browser search
  services/   catalog, cart, account, and parsing of Blinkit's layout payloads
  pay/        zpaykit API path, browser fallback, QR decoding, qrbaton / QR handoff
  types.ts    shared types
test/         vitest
```

## Development

| Script                  | Purpose                       |
| ----------------------- | ----------------------------- |
| `npm run dev -- <args>` | CLI from source (tsx)         |
| `npm run mcp`           | MCP server from source        |
| `npm test`              | Vitest                        |
| `npm run typecheck`     | Type-check `src/` and `test/` |
| `npm run build`         | Compile to `dist/`            |
| `npm run lint`          | Biome lint + format check     |
| `npm run format`        | Apply Biome fixes/formatting  |
| `npm run check`         | Lint, typecheck and tests     |

## Contributing

Issues and PRs welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md),
and report security problems privately as described in [SECURITY.md](SECURITY.md). Never paste your `session.json`,
OTPs, or pay links into an issue.

## License

[MIT](LICENSE)
