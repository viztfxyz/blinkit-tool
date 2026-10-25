# Contributing

Thanks for helping out! Bug reports, fixes, docs and new features are all welcome.

## Before you start

- **Bugs**: open an issue with the bug template. Blinkit changes its private API without notice, so the command
  you ran, the full error text and your pincode area (city is enough) help the most.
- **Features**: open an issue first for anything bigger than a small fix, so we can agree on the approach before
  you spend time on it.
- **Security problems**: don't open a public issue. See [SECURITY.md](SECURITY.md).

Never paste your `session.json`, OTPs, access tokens, pay links or full delivery address anywhere public.

## Setup

You need Node.js 20 or newer (the version in `.nvmrc` is what CI uses).

```bash
git clone https://github.com/viztfxyz/blinkit-tool.git
cd blinkit-tool
npm install
npm run check        # lint + typecheck + tests
```

Run the CLI and MCP server from source:

```bash
npm run dev -- search milk -p 560034
npm run mcp
```

Use a separate session file while developing so you don't disturb your real one:

```bash
BLINKIT_SESSION=/tmp/blinkit-dev.json npm run dev -- location 560034
```

## Making changes

1. Fork the repo and create a branch from `main` (`fix/cart-outcomes`, `feat/coupons`, …).
2. Keep changes focused: one fix or feature per pull request.
3. Add or update tests in `test/` for logic you change. Tests must not hit the network: stub `bk.raw` or `fetch`
   as the existing tests do.
4. Run `npm run format` to apply formatting, and `npm run check` before pushing.
5. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) if users would notice the change.
6. Open the pull request and fill in the template.

### Code layout

| Folder          | What lives there                                                            |
| --------------- | --------------------------------------------------------------------------- |
| `src/core/`     | Config, HTTP transport (Chrome TLS impersonation), session, storage, errors |
| `src/services/` | Catalog, cart, account, and parsing of Blinkit's layout payloads            |
| `src/pay/`      | zpaykit API path, browser fallback, QR decoding, qrbaton / QR handoff       |
| `src/cli/`      | Commander commands and terminal output                                      |
| `src/mcp/`      | MCP tool definitions                                                        |
| `src/bin/`      | Executable entry points                                                     |

### Guidelines

- Throw `BlinkitError` for anything the user can fix (bad input, not logged in, Blinkit refusing a request); the
  CLI and MCP server show its message as is.
- Anything that spends money must stay behind an explicit amount confirmation.
- Prefer small, readable functions over clever ones, and comment the _why_ when Blinkit's API forces something odd.

### Testing payment changes

Changes under `src/pay/` can place real orders. Use `blinkit pay --dry-run` first, test with a cheap cart, and say
in the pull request how you tested.

## Commit messages

Short imperative subject (`Fix cart outcome for capped quantities`), with a body explaining why when it isn't
obvious. [Conventional Commits](https://www.conventionalcommits.org) prefixes (`fix:`, `feat:`) are welcome but not
required.

## Releasing (maintainers)

1. Move the **Unreleased** notes in `CHANGELOG.md` under a new version heading.
2. `npm version <patch|minor|major>` (updates `package.json` and creates the tag), then `git push --follow-tags`.
3. Create a GitHub release for the tag. The `Release` workflow publishes to npm with provenance via
   [trusted publishing](https://docs.npmjs.com/trusted-publishers) (configure the repo as a trusted publisher on
   npmjs.com once; no npm token is stored in GitHub).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) and that you'll
follow the [Code of Conduct](CODE_OF_CONDUCT.md).
