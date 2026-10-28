import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Core } from "../src/platforms/blinkit/session.js";

/**
 * The MCP server keeps one Blinkit session for its whole life, while the detached pay child and the
 * CLI write the same file from other processes. Each `Core` here stands in for one process.
 */
describe("Blinkit session shared between processes", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "handcart-session-"));
    file = join(dir, "session.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sees the cart the pay child cleared, and doesn't write the bought items back", () => {
    const server = new Core(file);
    server.state.cart = { "470234": 2 };
    server.state.cartId = 111;
    server.save();

    // The pay child places the order, then empties the cart in its own copy of the session.
    const child = new Core(file);
    child.state.cart = {};
    child.state.cartId = null;
    child.save();

    expect(server.state.cart).toEqual({});
    expect(server.state.cartId).toBeNull();

    // The server's next cart change starts from the empty cart.
    server.state.cart["999"] = 1;
    server.save();
    expect(new Core(file).state.cart).toEqual({ "999": 1 });
  });

  it("picks up a login made from the CLI while it runs", () => {
    const server = new Core(file);
    server.save();
    expect(server.loggedIn).toBe(false);

    const cli = new Core(file);
    cli.state.accessToken = "token-from-cli";
    cli.save();

    expect(server.loggedIn).toBe(true);
  });

  it("keeps its own unsaved changes until something else writes the file", () => {
    const core = new Core(file);
    core.state.cart["1"] = 3;
    expect(core.state.cart).toEqual({ "1": 3 });
  });
});
