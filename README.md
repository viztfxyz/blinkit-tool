# handcart

[![CI](https://github.com/viztfxyz/handcart/actions/workflows/ci.yml/badge.svg)](https://github.com/viztfxyz/handcart/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/handcart)](https://www.npmjs.com/package/handcart)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

One cart for India's quick-commerce apps. Search across [Blinkit](https://blinkit.com) and
[Zepto](https://zepto.com) at once, compare prices for the same product, then cart, checkout and pay with
UPI on whichever is cheaper — as a **CLI**, a **TypeScript library**, and an **MCP server** for Claude,
Cursor and other agents.

```console
$ handcart search "surf excel"
surf excel · 2 platforms

Surf Excel Matic Top Load Liquid Detergent · 5 kg
  * zepto   ₹601   MRP ₹810  -26%   in stock  a3e1b947-86b8-4311-ab00-8b47928c8b0a
    blinkit ₹629   MRP ₹810  -22%   in stock  763523
  handcart zepto cart add a3e1b947-86b8-4311-ab00-8b47928c8b0a
```

Payment is headless on both platforms. The UPI QR is handed to whoever pays either as a
[qrbaton](https://qrbaton.vercel.app) pay page (items, bill, delivery address, one-tap GPay / PhonePe /
Paytm) or as a plain QR image.

> [!WARNING]
> Not affiliated with, endorsed by, or supported by Blinkit, Zepto or Zomato. It talks to the same private
> endpoints their apps use, which can change or break at any time, and automated use may be against their
> terms. Use it for your own accounts, at your own risk. Real orders and real money are involved:
> `pay` only proceeds when you pass the exact amount `checkout` showed.

## Requirements

- Node.js ≥ 22
- A Chromium-based browser, auto-detected. Zepto needs it to mint its WAF token at login; Blinkit only
  needs it for `pay --browser`.

## Install

```bash
npm install -g handcart
handcart setup            # guided: browser, logins, delivery addresses, then doctor
```

Or run it without installing: `npx handcart search milk`.

As a library: `npm install handcart`. To hack on it, see [CONTRIBUTING.md](CONTRIBUTING.md).

Coming from `blinkit-tool`? See [MIGRATING.md](MIGRATING.md).

## Platforms

| Platform  | `search` | `cart` → `checkout` → `pay` | `orders` | `categories` / `browse` / `locate` |
| --------- | :------: | :-------------------------: | :------: | :--------------------------------: |
| `blinkit` |    ✓     |              ✓              |          |                 ✓                  |
| `zepto`   |    ✓     |              ✓              |    ✓     |                                    |

`handcart platforms` prints this for your machine, with each platform's login and delivery address.
A platform only advertises what it can actually do, so commands it doesn't support don't appear in
`--help` for it, and a fan-out that skips it says so.

## CLI

Leave the platform out and the command fans out across every platform; name one to narrow it.

```bash
handcart search "amul taaza 500ml"      # every platform, grouped and price-compared
handcart zepto search paneer            # just Zepto
handcart cart                           # every cart you have open
handcart orders                         # merged, newest first
handcart whoami                         # login + delivery address per platform
handcart doctor                         # what isn't ready, and the command that fixes it
handcart location 560034                # one pincode, applied to every platform
```

Writes and anything needing a platform-specific product id always name the platform:

```bash
handcart zepto login 98xxxxxxxx         # SMS OTP
handcart zepto address use home         # label, id, or part of the address
handcart zepto cart add <id> -q 2
handcart zepto checkout                 # payable bill for that address
handcart zepto pay --confirm 642        # the exact amount checkout showed
```

Every listing command takes `--json`. `handcart <command> --help` lists all options.

> [!TIP]
> A price comparison is only meaningful when both platforms deliver to the same place. Run
> `handcart location <pincode>` first — `handcart whoami` will show if they disagree.

### Cross-platform search

`handcart search` groups what it believes is the same product and marks the cheapest in-stock row with
`*`, followed by a paste-ready add command for that row. Product ids stay visible because every write
takes a platform plus that platform's own id — there is deliberately no "add row 3" shorthand, since a
remembered row number means something different tomorrow and the next step spends money.

- `--by-platform` skips grouping and prints one plain list per platform.
- `--json` always returns **ungrouped** results tagged with `platform`, plus an `errors` array, so a
  machine consumer is never misled by a grouping decision.
- A group the matcher isn't sure about is marked `[uncertain match]` rather than merged silently.

Grouping affects display only. See [Matching](#matching).

### Sold-out products

Blinkit's search never returns sold-out products, and category listings put them at the very end, so by
default you mostly see what's in stock. Pass `--out-of-stock` (`-o`) to `search` or `browse`
(MCP: `includeOutOfStock: true`) to also list sold-out items, tagged `[OUT OF STOCK]` /
`inStock: false`, after the in-stock ones.

### Paying

`handcart <platform> pay --confirm <rupees>` places the order and waits for the UPI payment (10 minutes
by default). How the QR reaches the payer is set with `--handoff`:

| `--handoff`         | What you get                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qrbaton` (default) | A [qrbaton](https://qrbaton.vercel.app) link. The page shows the items, bill and delivery address; the payer taps Pay to open their UPI app, and the page updates when the payment completes. No account or API key. |
| `qr`                | Just the UPI QR as a PNG (and the `upi://` link). Nothing leaves your machine except the payment itself.                                                                                                             |

If qrbaton can't be reached, `pay` falls back to the plain QR and says so. The QR PNG is always saved
under `~/.cache/handcart/`.

Other options: `--no-open` prints the link / QR path instead of opening it, `--agent <name>` shows who
prepared the order on the pay page, `--dry-run` stops before a QR is generated.

> qrbaton never handles money, but anyone with a pay link can see the order, including the delivery
> address. Use `--handoff qr` if you don't want that.

## Matching

Deciding that Blinkit's `Amul Gold Milk` and Zepto's `Amul Gold Homogenised Standardised Milk (Tetra
Pack)` are the same thing is the hard part, and neither platform exposes a barcode. Handcart does it with
no dependencies, no model and no network, in under a millisecond:

1. **Quantity, as a hard gate.** `500 ml`, `1 ltr`, `1 pack (500 ml)`, `6 pcs`, `2 x 500 ml` all
   normalise to a value and a class, and a mismatch can never group. This is what stops a 1 L carton
   looking cheaper than a 500 ml pouch.
2. **Brand gate.** Two known-but-different brands never group.
3. **Name similarity plus MRP.** Maximum Retail Price is printed on the pack by law and is the same in
   every store, which makes it the strongest signal available. Hindi-English and spelling variants are
   collapsed first (`dahi`/`curd`, `namak`/`salt`, `arhar`/`toor`, `iodised`/`iodized`).
4. **Mutual-best assignment**, so each product claims at most one counterpart on another platform.

Measured against 1,200 real products captured from both platforms over 30 queries, hand-labelled, in
`test/fixtures/match/`: **97.1% precision, 97.1% recall**. `npm run bench:match` reproduces it, and it
and `npm test` fail below 97% precision or 95% recall. Every remaining mistake is marked `[uncertain match]`.

## MCP server (Claude, Cursor, Grok…)

```json
{
  "mcpServers": {
    "handcart": {
      "command": "npx",
      "args": ["-y", "handcart", "mcp"]
    }
  }
}
```

- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart Claude
- **Claude Code**: `claude mcp add handcart -- npx -y handcart mcp`
- **Cursor**: `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)
- **Grok CLI**: `grok mcp add handcart -- npx -y handcart mcp`

Run `handcart setup` once from a terminal, or let the agent log in with the OTP tools.
The server runs on your machine, so cloud-only agents can't reach it.

### Agent flow

Handcart-level tools (`doctor`, `platforms`, `search`, `cart`, `orders`, `whoami`) cover every platform;
per-platform tools are `<platform>_<verb>`.

`doctor` → `platforms` → (login: `<p>_login_request_otp`, `<p>_login_verify_otp`) → `<p>_use_address` →
`search` → `<p>_cart_set` → `<p>_checkout` → **user confirms the amount** → `<p>_pay` → poll
`<p>_pay_status` until `qr_ready` → send the user `payLink` (or, with `handoff: "qr"`, the QR image).

The instructions tell agents never to request an OTP for a number the user didn't give, and never to call
a `pay` tool without explicit confirmation of the exact amount from `checkout`.

## Library

```ts
import { Blinkit, client, platforms, group } from "handcart";

// Platform-neutral: whatever is registered
for (const p of platforms()) console.log(p.name, p.capabilities);
const zepto = client("zepto");
const found = await zepto.search("milk", { limit: 5 });
await zepto.add(found[0].id, 2);

// Compare across platforms yourself
const tagged = found.map((p) => ({ ...p, platform: "zepto" }));
for (const g of group(tagged))
  console.log(
    g.title,
    g.offers.map((o) => `${o.platform} ₹${o.price}`),
  );

// Or reach for one platform's full client
const bk = new Blinkit();
await bk.setLocation({ pincode: "560034" });
await bk.catalog.search("milk", { sort: "price", inStock: true, limit: 5 });
```

## Configuration

| Variable           | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `HANDCART_BROWSER` | Chromium-based browser to use (auto-detected otherwise)                  |
| `BLINKIT_SESSION`  | Blinkit session file (default `~/.config/handcart/session.json`)         |
| `ZEPTO_COOKIES`    | Zepto cookie jar (default `~/.config/handcart/zepto.cookies`)            |
| `QRBATON_URL`      | qrbaton host, if you run your own (default `https://qrbaton.vercel.app`) |

Sessions and cookies live in `~/.config/handcart/`, owner-readable only; caches in `~/.cache/handcart/`.
The pre-rename `BLINKIT_*` names still work with a deprecation notice, and directories left behind by
`blinkit-tool` are moved across on first run so you don't have to log in again.

## Troubleshooting

Run `handcart doctor` first — it names the command that fixes each `✗`.

- **"refusing automated requests"**: Cloudflare or Zepto's WAF is challenging the request. Wait a few minutes and retry.
- **"session expired or not logged in"**: `handcart <platform> login <phone>`.
- **Prices look wrong next to each other**: the platforms are probably set to different addresses. `handcart whoami`, then `handcart location <pincode>`.
- **Search doesn't show something you expected**: it may be sold out; retry with `--out-of-stock`.
- **`pay` says the amount differs**: the bill changed (stock, charges, promo). Re-run `checkout` and confirm the new amount.

## Development

Project layout, scripts and how to run from source (`npm run dev`, `npm run mcp`) are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Issues and PRs welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the
[Code of Conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in
[SECURITY.md](SECURITY.md). Never paste your session files, cookie jars, OTPs, or pay links into an issue.

## License

[MIT](LICENSE)
