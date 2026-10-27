# Migrating from `blinkit-tool` to `handcart`

`blinkit-tool` was a Blinkit client. `handcart` is the same thing with Zepto alongside it, every store a
peer behind one registry, and cross-platform price comparison. Blinkit's behaviour is unchanged — same
endpoints, same auth, same parsing.

## Install

```bash
npm uninstall -g blinkit-tool
npm install -g handcart
handcart doctor
```

## Your logins carry over

Sessions and cookies move from `~/.config/blinkit-tool/` to `~/.config/handcart/` automatically on the
first run, and `~/.cache/` likewise. Handcart prints one line when it does this and never overwrites an
existing `handcart` directory. You should not have to log in again.

## Commands

The `blinkit` command is now `handcart`, and Blinkit's commands moved behind the platform name, because
bare commands now fan out across every platform.

| Before                         | Now                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `blinkit search milk`          | `handcart blinkit search milk`, or `handcart search milk` for every platform |
| `blinkit login <phone>`        | `handcart blinkit login <phone>`                                             |
| `blinkit address use home`     | `handcart blinkit address use home`                                          |
| `blinkit cart add 211410 -q 2` | `handcart blinkit cart add 211410 -q 2`                                      |
| `blinkit checkout`             | `handcart blinkit checkout`                                                  |
| `blinkit pay --confirm 642`    | `handcart blinkit pay --confirm 642`                                         |
| `blinkit location 560034`      | `handcart location 560034` (applies to every platform)                       |
| `blinkit doctor`               | `handcart doctor`                                                            |

New: `handcart platforms`, and bare `handcart search` / `cart` / `orders` / `whoami` fan out.

## MCP tool ids changed

This breaks existing agent configuration. Rename the server to `handcart`:

```json
{ "mcpServers": { "handcart": { "command": "npx", "args": ["-y", "handcart", "mcp"] } } }
```

Blinkit's tools keep their `blinkit_` prefix (`blinkit_search`, `blinkit_cart_set`, `blinkit_pay`…), but
what used to be `blinkit_session` and `doctor` are now the handcart-level `whoami` and `doctor`, which
report every platform. There are new handcart-level `search`, `cart`, `orders` and `platforms` tools.

## Library

`new Blinkit()` and `bk.catalog.search(...)` still work. Two things to know:

- `BlinkitError` is now `HandcartError`.
- Product ids are strings at the platform-neutral boundary (`client("blinkit").search(...)` returns
  `id: string`). `new Blinkit()` still returns Blinkit's numeric `productId` as before.

New platform-neutral surface: `platforms()`, `client(name)`, and `group(taggedProducts)` for matching.

## Environment variables

`BLINKIT_BROWSER` is now `HANDCART_BROWSER`. The old name still works and prints a deprecation notice.
Platform-scoped names keep their prefix: `BLINKIT_SESSION`, `ZEPTO_COOKIES`.
