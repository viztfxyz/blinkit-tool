# Amazon login: the tool's own browser, and say what it's doing

Date: 2026-10-27
Size: small change

## Intent and why

Running `blinkit amazon login` on a Mac launched Arc, which came to the front and restored the
user's own tabs (blinkit.com among them). Nothing in the tool navigated there — Arc ignores
Playwright's `--headless` and temp-profile flags and just boots as the app — but from the outside it
looked like the tool was rifling through the user's browser. That is the thing to kill: the tool
must never touch a browser the user browses in, and it must say out loud what it is doing while it
drives the one it owns.

## Goals

- Login and pay only ever run in a browser the tool owns, with its own empty profile.
- Headless login on a server keeps working exactly as it does today.
- The user can read, in the terminal, each step the sign-in takes.

## Non-goals

- Replacing the scripted OTP login with manual sign-in.
- Session export/import between machines.
- Changing how Blinkit (non-Amazon) login works — it is plain HTTP, no browser.

## Anti-goals

- A flow where the user cannot tell which browser or profile was touched. Silent correctness is
  still a failure here.

## Constraints

- `blinkit amazon login` must work with no display (MCP server, SSH).
- `--json` output stays machine-readable: progress goes to stderr.
- Amazon's sign-in screens only exist as pages, so Chromium stays in the login path.

## Approaches

- **A. Own browser, narrated steps** (chosen). `findBrowser()` stops scanning for installed
  browsers; it returns `$BLINKIT_BROWSER` or Playwright's own Chromium, nothing else. Setup
  downloads Chromium when it is missing rather than borrowing Chrome/Arc. Login prints what it is
  doing as it does it. Smallest change, removes the actual violation.
- **B. A, plus manual login when there is a display.** Honest where it can be, but two login paths
  to maintain and the headless path is still scripted — the sketchy-looking part stays.
- **C. A, plus session export/import.** Log in on the laptop, import on the server. Useful, but a
  fourth flow that does not replace headless login.

## The design

1. `src/core/browser.ts` — `findBrowser()` returns the first of: `$BLINKIT_BROWSER` (explicit user
   opt-in, honoured as-is), then `chromium.executablePath()` from the playwright-core we launch
   with. Delete the macOS `/Applications` list, the Windows Program Files list and the `$PATH`
   name scan, and `isRunnableBrowser` with them. The not-found error names
   `npx playwright install chromium` as the fix.
2. `src/cli/setup.ts` — the browser step says the download is Chromium for the tool's own use
   (~150 MB) before asking. When a browser is found it prints whether that is the tool's Chromium
   or a `$BLINKIT_BROWSER` override.
3. `src/doctor.ts` — the Browser check's detail distinguishes "Chromium (downloaded for this tool)"
   from "$BLINKIT_BROWSER override"; the fix line stays `npx playwright install chromium`.
4. `src/amazon/login.ts` — a `progress` callback (default: a line on stderr) reporting, in order:
   the sign-in URL being opened, the number the phone field was filled with (masked), the OTP
   request, and the channel Amazon says it used. The CLI and setup print these; MCP ignores them.
   No behaviour change to the sign-in walk itself.
5. `src/pay/handoff.ts` — `openUrl` prints `Opening <url> in your default browser` before spawning
   the opener, so the one place that *does* touch the user's browser announces itself.
   `--no-open` already suppresses it.
6. README: the sentence about which browser is used gets corrected to match.

## Left to the builder

- Exact wording of the progress lines, as long as each names the host being contacted.
- Whether `progress` is a constructor option on `NowLogin` or a parameter on `requestOtp`.

## Verification

- Existing tests pass (`test/setup.test.ts`, `test/amazon.test.ts`).
- New: `findBrowser()` returns Playwright's path and never an `/Applications` path, and
  `$BLINKIT_BROWSER` wins over it.
- New: `requestOtp` emits progress lines in order.
