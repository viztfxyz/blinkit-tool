import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Atomic write; `secret` files (the session) are made readable by the owner only. */
export function writeJson(path: string, data: unknown, secret = false): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 1));
    if (secret) chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    // caches and status files are best-effort
  }
}
