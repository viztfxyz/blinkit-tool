# Handcart — multi-platform restructure

Status: agreed with Viz, 2026-10-27. This document is the contract implementers build from.

## Intent

`blinkit-tool` was built for Blinkit, then grew an Amazon Now platform, then a Zepto platform
on top of that. The result is lopsided: Blinkit sits at the repo root and owns the generic
names, while the other platforms live in namespaced folders. Adding platform #4 currently
means hand-writing a CLI module and an MCP module for it.

Rename the project to **Handcart** and restructure it so every platform is a peer behind one
registry, so that adding a platform is one client, one parser and one registry entry.

## Goals

- Blinkit and Zepto land on `main` as peers, with the Amazon work excluded.
- Adding a platform does not require touching the CLI or MCP front-ends.
- `handcart search <q>` compares prices for the same product across platforms.
- Human-readable output stays the default; `--json` stays the opt-in.

## Non-goals

- **Amazon Now is not part of this work.** `feat/amazon-now` stays exactly as it is and is
  not merged, ported or referenced. Whoever picks it up later re-ports it onto the registry.
- No change to how any platform's API is spoken to. Transport, auth and parsing behaviour
  for Blinkit and Zepto must stay byte-for-byte equivalent.
- No new runtime dependency. The matcher is plain TypeScript.

## Anti-goals

- A platform contract so tight that a future platform needs a hack to fit. Capabilities are
  declared and optional.
- A cross-platform product match that could cause a wrong purchase. Grouping affects
  **display only**; every write takes a platform plus that platform's own product id.
- Silently losing users' sessions in the rename.

## Constraints

- Node >= 22, ESM, TypeScript, Biome, Vitest. `npm run check` must pass.
- Zepto imports two things from `src/amazon/`: `upiAmount`/`upiExpiry` from
  `amazon/parsing.ts` and the cookie jar from `amazon/cookies.ts`. Both are
  platform-neutral and move to `core/`. Nothing else from `src/amazon/` comes across.
- `main` contains `d6652a2` (QR expiry closes the pay page), which `feat/zepto` lacks.
  Work branches from `main`, not from `feat/zepto`.

## Approaches considered

1. **Peers + registry only.** Move Blinkit beside Zepto, extract a real core, registry maps
   name to factory. Front-ends still hand-written per platform. Cheap; does not reduce the
   per-platform cost.
2. **Peers + registry + a platform contract** (chosen). Same moves, plus the interface the
   clients have already converged on, so CLI and MCP surfaces are written once and driven by
   the registry. Costs more up front; platform #4 becomes nearly free.
3. **Core extraction only, defer the rest.** Fastest to a merge, keeps the asymmetry, pays
   for the restructure later against a larger Amazon branch.

Chosen: **2**, staged so the foundation lands before the fan-out surface.

## Target layout

```
src/
  bin/handcart.ts            # CLI entry
  bin/handcart-mcp.ts        # MCP stdio entry
  core/
    config.ts                # paths (~/.config/handcart), VERSION, migration
    errors.ts http.ts storage.ts
    browser.ts               # Chromium lookup + install hint
    cookies.ts               # was src/amazon/cookies.ts (Netscape jar)
    upi.ts                   # was upiAmount/upiExpiry in src/amazon/parsing.ts
    types.ts                 # shared Product/Cart/Bill/Address/Order + Tagged<T>
    match.ts                 # cross-platform grouping (pure)
  platforms/
    registry.ts              # name -> Platform descriptor
    blinkit/                 # was src/client.ts, src/services/*, src/core/session.ts
    zepto/                   # was src/zepto/*
  pay/                       # shared UPI QR pay (unchanged behaviour)
  cli/   main.ts format.ts prompt.ts setup.ts doctor.ts
  mcp/   server.ts tools.ts
test/
  fixtures/match/            # real captured search results + hand labels
```

## The platform contract

A platform is registered as a descriptor. Required members are the ones all clients already
have; anything a platform cannot do is declared as an absent capability, and the front-ends
omit that command for it and say so when a fan-out skips it.

```ts
export interface PlatformDescriptor {
  name: string;                       // "blinkit" | "zepto"
  label: string;                      // "Blinkit"
  create(): Platform;                 // lazy; never constructed until used
  capabilities: Capability[];         // declared, checked at registration
}
export type Capability =
  | "search" | "product" | "cart" | "checkout" | "pay" | "orders"
  | "addresses" | "login"
  | "categories" | "browse" | "locate";   // Blinkit-only today

export interface Platform {
  requestOtp(phone: string): Promise<{ sent: true; to: string }>;
  verifyOtp(code: string): Promise<unknown>;
  logout(): unknown;
  whoami(): Promise<PlatformSession>;
  addresses(): Promise<Address[]>;
  useAddress(which: string): Promise<Address>;
  search(query: string, opts?: SearchOptions): Promise<Product[]>;
  product(id: string): Promise<Product>;
  cart(): Promise<Cart>;
  setQuantity(id: string, quantity: number): Promise<Cart>;
  add(id: string, quantity?: number): Promise<Cart>;
  clear(): Promise<Cart>;
  checkout(): Promise<Bill>;
  orders?(): Promise<Order[]>;
  pay?(opts: PayOptions): Promise<PayStatus>;
  // optional, Blinkit today
  categories?(): Promise<CategoryGroup[]>;
  findCategory?(name: string): Promise<CategoryMatch>;
  browse?(category: string, opts?: SearchOptions): Promise<BrowseResult>;
  locate?(pincode: string): Promise<Location>;
  setLocation?(where: LocationInput): Promise<Location>;
}
```

`Product` ids are **strings** across the board. Blinkit's numeric `productId` is stringified
at the platform boundary and parsed back inside the Blinkit client, so no other layer knows
the difference. Library users keep `new Blinkit()` and `bk.catalog.search(...)` working; the
descriptor wraps it.

## Command surface

Fan-out is the default; naming a platform narrows to it.

| bare (all platforms) | narrowed |
| --- | --- |
| `handcart search <q>` merged comparison | `handcart zepto search <q>` |
| `handcart cart` every open cart | `handcart zepto cart` |
| `handcart orders` merged, newest first | `handcart zepto orders` |
| `handcart whoami` one line per platform | `handcart zepto whoami` |
| `handcart doctor` all checks | `handcart zepto doctor` |

Platform required (writes, or needs a platform-specific id):

```
handcart <p> login <phone> | verify <code> | logout
handcart <p> address list | use <which>
handcart <p> product <id>
handcart <p> cart add <id> [qty] | set <id> <qty> | remove <id> | clear
handcart <p> checkout
handcart <p> pay [--confirm <amount>]
handcart <p> categories [name] | browse <category>      # capability-gated
```

Handcart level:

```
handcart location <pincode>   # one pincode applied to every platform
handcart platforms            # supported platforms, state, capabilities
handcart setup                # guided, human, interactive
handcart mcp                  # stdio MCP server
```

A fan-out never fails wholesale. It returns what it got plus a per-platform error list, and
prints the failures as `! <platform>: <reason> — run \`<fix>\`` lines after the results.

## Output

`handcart search` groups likely matches, marks the cheapest in-stock row, and prints a
paste-ready add command for that row. Ids stay visible; there is no "add row 1" shorthand,
because a remembered index means a different thing on a different day and the next step
spends money.

```
$ handcart search "amul taaza 500ml"
amul taaza 500ml · 110017 · 2 platforms

Amul Taaza Toned Milk · 500 ml
  * zepto     Rs 27   MRP 29  -7%   in stock   5f8a21c3
    blinkit   Rs 28                 in stock   470234
  handcart zepto cart add 5f8a21c3

! amazon: not configured
```

Uncertain groups are marked and never silently merged. `--by-platform` prints plain
per-platform lists. `--json` always returns **ungrouped** tagged results plus `errors`, so a
machine consumer is never misled by a grouping decision.

## Matching

Pure, deterministic, zero-dependency, in `src/core/match.ts`. Measured on 1,200 real
products captured from Blinkit and Zepto (30 queries, in `test/fixtures/match/`):
**97.1% precision, 97.1% recall**, 1.7 ms to group 60 products.

Four stages:

1. **Quantity gate (hard).** Parse `unit` and `name` into `{value, class}` where class is
   `vol | mass | count`, normalising `500 ml`, `1 ltr`, `1 pack (500 ml)`, `6 pcs`,
   `2 x 500 ml`, `pack of 6`. Mismatch means the pair can never group. This is what stops a
   1 L carton looking cheaper than a 500 ml pouch. Parsed 100% of the real corpus.
2. **Brand gate.** Two known-but-different brands can never group; one side unknown passes.
3. **Score.** `0.45 * trigramDice(rawNames) + 0.55 * idfCosine(canonTokens)`, `+0.30` when
   `mrp` is equal and non-zero else `-0.18`, `-0.12` per variant-marker token present on
   exactly one side. MRP is the strong signal because it is printed on the pack by law and
   is the same in every store. Token canon maps Hindi-English and spelling variants:
   `dahi->curd`, `namak->salt`, `arhar|tuver|tur->toor`, `chai->tea`, `atta->flour`,
   `iodised==iodized`, `homogenised==homogenized`.
4. **Mutual-best 1:1, per query.** Greedy highest-score-first assignment so each product on
   one platform claims at most one product on another. This was the single largest win
   (+11.6pp recall at fixed precision) and it **must** be scoped per query, not globally.

Measured and rejected, with numbers, so nobody re-litigates them:

| idea | result |
| --- | --- |
| name similarity alone (jaccard/dice/overlap/idf/trigram/levenshtein) | 70.9-81.3% F1 |
| MRP equality alone | 84.4% F1 |
| variant markers derived from data instead of a word list | 95.8% F1 (worse) |
| pack-count gate | 96.4% F1 (worse) |
| combo-wording gate | 95.9% F1 (worse) |
| local ONNX sentence embeddings | unnecessary; rules reach 97% with no dependency |
| LLM adjudication | unnecessary, and wrong for an offline CLI |

Known errors are documented in `test/fixtures/match/candidates.txt`. Three of the eight are
Tata Tea rows where the hand label itself is arguable.

Thresholds are not hand-waved: `npm run bench:match` reports precision and recall against
the fixtures and must stay at or above **97% precision and 95% recall** or CI fails.

Left to the builder: whether the link cache (`~/.config/handcart/links.json`, so confirmed
matches persist and a human correction sticks) lands now or in a follow-up. It is not
required to hit the numbers above.

## Rename

- npm package `handcart`; bins `handcart` and `handcart-mcp`; MCP server name `handcart`.
- MCP tool ids become `<platform>_<verb>` (`blinkit_search`, `zepto_cart_set`) plus
  handcart-level `search`, `cart`, `orders`, `whoami`, `doctor`, `platforms`. This is a
  breaking change for existing agent configs and belongs in the changelog.
- Env vars `BLINKIT_*` -> `HANDCART_*`, with the old names still honoured and a deprecation
  notice, except `BLINKIT_SESSION` which stays platform-scoped.
- `BlinkitError` -> `HandcartError`.
- **Config migration.** Sessions and cookies live in `~/.config/blinkit-tool/`. On first run,
  if that exists and `~/.config/handcart/` does not, move it and print one line saying so.
  Without this every user silently loses all logins. Same for `~/.cache/`.
- `basket@1.0.0` is unreachable on npm, which is why the name is `handcart`; it has no
  publish history, so any version number is available.
