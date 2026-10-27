/**
 * A store session as a Netscape cookie file. curl (via cuimp) reads and rewrites it on every HTTP call,
 * which matters because stores rotate their auth cookies through Set-Cookie and cuimp's parsed headers
 * keep only the last Set-Cookie. Chromium is seeded from the same file and writes back to it, so there
 * is one session no matter which side made the last request.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The subset of Playwright's cookie shape we round-trip. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

const HTTP_ONLY = "#HttpOnly_";

export function parseNetscape(text: string): BrowserCookie[] {
  const out: BrowserCookie[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    let httpOnly = false;
    if (line.startsWith(HTTP_ONLY)) {
      httpOnly = true;
      line = line.slice(HTTP_ONLY.length);
    } else if (!line.trim() || line.startsWith("#")) {
      continue;
    }
    const f = line.split("\t");
    if (f.length < 7) continue;
    const [domain, , path, secure, expires, name, ...value] = f;
    const exp = Number(expires);
    out.push({
      name,
      value: value.join("\t"),
      domain,
      path,
      expires: exp > 0 ? exp : -1,
      httpOnly,
      secure: secure === "TRUE",
    });
  }
  return out;
}

export function toNetscape(cookies: BrowserCookie[], title = "Store session"): string {
  const lines = cookies.map((c) => {
    const sub = c.domain.startsWith(".") ? "TRUE" : "FALSE";
    const exp = c.expires > 0 ? Math.floor(c.expires) : 0;
    const domain = `${c.httpOnly ? HTTP_ONLY : ""}${c.domain}`;
    return [domain, sub, c.path || "/", c.secure ? "TRUE" : "FALSE", exp, c.name, c.value].join("\t");
  });
  return `# Netscape HTTP Cookie File\n# ${title} for handcart. Treat like a password.\n\n${lines.join("\n")}\n`;
}

export function readCookies(file: string): BrowserCookie[] {
  return existsSync(file) ? parseNetscape(readFileSync(file, "utf8")) : [];
}

/** Atomic, owner-readable only: anyone with this file can shop as the account. */
export function writeCookies(file: string, cookies: BrowserCookie[], title?: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, toNetscape(cookies, title), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
