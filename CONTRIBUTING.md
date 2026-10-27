# Contributing

Thanks for helping out! Bug reports, fixes, docs and new features are all welcome.

## Before you start

- **Bugs**: open an issue with the bug template. Blinkit and Zepto change their private APIs without notice, so the
  platform, the command you ran, the full error text and your pincode area (city is enough) help the most.
- **Features**: open an issue first for anything bigger than a small fix, so we can agree on the approach before
  you spend time on it.
- **Security problems**: don't open a public issue. See [SECURITY.md](SECURITY.md).

Never paste your `session.json`, `zepto.cookies`, OTPs, access tokens, pay links or full delivery address anywhere public.

## Setup

You need Node.js 22 or newer (the version in `.nvmrc` is what CI uses).

```bash
git clone https://github.com/viztfxyz/handcart.git
cd handcart
npm install
npm run check        # lint + typecheck + tests
```

Run the CLI and MCP server from source:

```bash
npm run dev -- search milk -p 560034
npm run mcp
```

To try MCP tool changes in an agent without building, point its MCP config at
`npx tsx src/bin/handcart-mcp.ts` (what `npm run mcp` runs) with the repo root as its working directory.

Use separate session files while developing so you don't disturb your everyday logins:

```bash
BLINKIT_SESSION=/tmp/blinkit-dev.json ZEPTO_COOKIES=/tmp/zepto-dev.cookies npm run dev -- location 560034
```

## Making changes

1. Fork the repo and create a branch from `main` (`fix/cart-outcomes`, `feat/coupons`, …).
2. Keep changes focused: one fix or feature per pull request.
3. Add or update tests in `test/` for logic you change. Tests must not hit the network: stub the platform client or
   `fetch` as the existing tests do.
4. Run `npm run format` to apply formatting, and `npm run check` before pushing. If you touch
   `src/core/match.ts`, also run `npm run bench:match`.
5. Open the pull request with a [Conventional Commit](#commit-messages) title and fill in the template.
   The changelog is written from it automatically.

### Project layout

```
src/
  bin/                CLI and MCP entry points
  core/               config, HTTP transport (Chrome TLS impersonation), storage, cookies,
                      browser lookup, UPI QR parsing, shared types, cross-platform matcher
  platforms/
    registry.ts       the Platform contract; a new store is one entry here
    blinkit/          client, session, catalog, cart, account, parsing
    zepto/            client, session, parsing, request signing, pay
  pay/                UPI QR pay: zpaykit path, browser fallback, QR decoding, handoff
  cli/                commander commands, terminal formatting, setup, doctor
  mcp/                MCP server, generated from the registry
test/
  fixtures/match/     corpus.json (captured search results) + labels.json (hand labels) for the matcher
```

Adding a platform is a client, a parser and one `register` call — the CLI and MCP surfaces are written
once against the registry and pick it up automatically.

### Scripts

| Script                  | Purpose                       |
| ----------------------- | ----------------------------- |
| `npm run dev -- <args>` | CLI from source (tsx)         |
| `npm run mcp`           | MCP server from source        |
| `npm test`              | Vitest                        |
| `npm run bench:match`   | Matcher precision/recall gate |
| `npm run typecheck`     | Type-check `src/` and `test/` |
| `npm run build`         | Compile to `dist/`            |
| `npm run lint`          | Biome lint + format check     |
| `npm run format`        | Apply Biome fixes/formatting  |
| `npm run check`         | Lint, typecheck and tests     |

### Guidelines

- Throw `HandcartError` for anything the user can fix (bad input, not logged in, a platform refusing a request);
  the CLI and MCP server show its message as is.
- Anything that spends money must stay behind an explicit amount confirmation.
- Prefer small, readable functions over clever ones, and comment the _why_ when a platform's API forces something odd.

### Testing payment changes

Changes under `src/pay/` can place real orders. Use `handcart <platform> pay --dry-run` first, test with a cheap cart, and say
in the pull request how you tested.

## Commit messages

Releases are automated from commit messages, so use [Conventional Commits](https://www.conventionalcommits.org).
For pull requests only the **PR title** matters (PRs are squash-merged):

| Prefix                                  | Use for                          | Release                           |
| --------------------------------------- | -------------------------------- | --------------------------------- |
| `feat:`                                 | A new feature                    | minor (0.**2**.0)                 |
| `fix:`                                  | A bug fix                        | patch (0.1.**1**)                 |
| `perf:`, `docs:`, `deps:`               | Speedups, docs, dependency bumps | patch, listed in the changelog    |
| `chore:`, `ci:`, `test:`, `refactor:`   | Everything else                  | no release on its own             |
| `feat!:` or a `BREAKING CHANGE:` footer | Breaking changes                 | minor while below 1.0, then major |

Examples: `feat: add coupon support to checkout`, `fix(cart): keep capped quantities`.

## Releasing (maintainers)

Nothing to do by hand:

1. Merge pull requests into `main` as usual.
2. The **Release** workflow keeps a PR titled `chore(main): release x.y.z` open, with the version bump and
   changelog. Review it.
3. Merge it when you want to ship. The workflow tags `vX.Y.Z`, creates the GitHub release, and publishes to npm
   via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (no npm token stored in GitHub).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) and that you'll
follow the [Code of Conduct](CODE_OF_CONDUCT.md).
