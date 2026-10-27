import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyDirs } from "../src/core/config.js";

/**
 * The rename moves where every session and cookie lives. If this migration is wrong, existing users
 * silently lose all their logins on first run, so it gets its own tests.
 */
describe("legacy config migration", () => {
  let home: string;
  const logged: string[] = [];
  const log = (m: string) => logged.push(m);
  const seed = (kind: string, file: string, body: string) => {
    mkdirSync(join(home, kind, "blinkit-tool"), { recursive: true });
    writeFileSync(join(home, kind, "blinkit-tool", file), body);
  };
  const read = (kind: string, file: string) => readFileSync(join(home, kind, "handcart", file), "utf8");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handcart-home-"));
    logged.length = 0;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("moves sessions and cookies to the handcart directory, contents intact", () => {
    seed(".config", "session.json", '{"token":"keep-me"}');
    seed(".config", "zepto.cookies", "cookie-jar");
    seed(".cache", "locations.json", "[]");

    migrateLegacyDirs(home, log);

    expect(read(".config", "session.json")).toBe('{"token":"keep-me"}');
    expect(read(".config", "zepto.cookies")).toBe("cookie-jar");
    expect(read(".cache", "locations.json")).toBe("[]");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("renamed project");
  });

  it("says nothing and does nothing when there is no legacy directory", () => {
    migrateLegacyDirs(home, log);
    expect(logged).toEqual([]);
  });

  it("never clobbers an existing handcart directory", () => {
    seed(".config", "session.json", '{"token":"old"}');
    mkdirSync(join(home, ".config", "handcart"), { recursive: true });
    writeFileSync(join(home, ".config", "handcart", "session.json"), '{"token":"current"}');

    migrateLegacyDirs(home, log);

    expect(read(".config", "session.json")).toBe('{"token":"current"}');
    expect(logged).toEqual([]);
  });

  it("is idempotent: a second run is a no-op", () => {
    seed(".config", "session.json", '{"token":"keep-me"}');
    migrateLegacyDirs(home, log);
    logged.length = 0;

    migrateLegacyDirs(home, log);

    expect(read(".config", "session.json")).toBe('{"token":"keep-me"}');
    expect(logged).toEqual([]);
  });

  it("migrates .cache even when .config was already migrated", () => {
    seed(".cache", "locations.json", "[]");
    mkdirSync(join(home, ".config", "handcart"), { recursive: true });

    migrateLegacyDirs(home, log);

    expect(read(".cache", "locations.json")).toBe("[]");
    expect(logged[0]).toContain(".cache/blinkit-tool");
  });
});
