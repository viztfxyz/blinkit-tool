import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HandcartError } from "../src/core/errors.js";
import { claimPayLock, payBusy, payExclusively, payLockFile, readPayLock, releasePayLock } from "../src/pay/lock.js";
import { type PayStatus, readPayStatus, writePayStatus } from "../src/pay/status.js";

const lockFile = () => payLockFile(join(mkdtempSync(join(tmpdir(), "handcart-lock-")), "pay_status.json"));
const now = 1_800_000_000_000;
const done: PayStatus = { stage: "paid", ts: now - 60_000 };
const alive = (pid: number) => pid === 100;

describe("payBusy", () => {
  it("refuses while a live run holds the lock", () => {
    const lock = { pid: 100, expiresAt: now + 60_000 };
    expect(payBusy({ stage: "launching", ts: now }, lock, { now, isAlive: alive })).toMatch(/in progress/);
    expect(payBusy(done, lock, { now, isAlive: alive })).toMatch(/in progress/);
  });

  it("ignores a dead or expired holder", () => {
    expect(payBusy(done, { pid: 200, expiresAt: now + 60_000 }, { now, isAlive: alive })).toBeNull();
    expect(payBusy(done, { pid: 100, expiresAt: now - 1 }, { now, isAlive: alive })).toBeNull();
    // Crashed mid-run: the stage is stale, the lock says so.
    const crashed = { pid: 200, expiresAt: now + 60_000 };
    expect(payBusy({ stage: "launching", ts: now - 1000 }, crashed, { now, isAlive: alive })).toBeNull();
  });

  it("lets a run inherit its parent's lock", () => {
    const lock = { pid: 100, expiresAt: now + 60_000 };
    expect(payBusy(done, lock, { now, isAlive: alive, heir: 100 })).toBeNull();
  });

  it("refuses while the last run's QR can still be paid, even with the run gone", () => {
    const qr: PayStatus = { stage: "qr_ready", ts: now - 60_000, qrExpiresAt: now + 120_000 };
    expect(payBusy(qr, undefined, { now, isAlive: alive })).toMatch(/QR can still be paid/);
    expect(payBusy({ ...qr, qrExpiresAt: now - 1 }, undefined, { now, isAlive: alive })).toBeNull();
    // No known expiry: the default pay timeout.
    expect(payBusy({ stage: "qr_ready", ts: now - 60_000 }, undefined, { now })).toMatch(/QR/);
    expect(payBusy({ stage: "qr_ready", ts: now - 700_000 }, undefined, { now })).toBeNull();
  });

  it("treats a recent unlocked start as running, and an old one as stale", () => {
    expect(payBusy({ stage: "starting", ts: now - 10_000 }, undefined, { now })).toMatch(/in progress/);
    expect(payBusy({ stage: "launching", ts: now - 600_000 }, undefined, { now })).toBeNull();
    expect(payBusy({ stage: "error", ts: now }, undefined, { now })).toBeNull();
  });
});

describe("claimPayLock", () => {
  it("lets one run in and keeps the next out while it lives", () => {
    const file = lockFile();
    expect(claimPayLock(file, process.pid, 60_000)).toBe(true);
    expect(readPayLock(file)?.pid).toBe(process.pid);
    // The holder is alive (it's us), so a second claimant is refused, even one with our own pid.
    expect(claimPayLock(file, 999_999_999, 60_000)).toBe(false);
    expect(claimPayLock(file, process.pid, 60_000)).toBe(false);
    releasePayLock(file, process.pid);
    expect(readPayLock(file)).toBeUndefined();
  });

  it("hands the lock to the heir", () => {
    const file = lockFile();
    claimPayLock(file, process.pid, 60_000);
    expect(claimPayLock(file, 4242, 60_000, process.pid)).toBe(true);
    expect(readPayLock(file)?.pid).toBe(4242);
    // Only the holder can release it.
    releasePayLock(file, process.pid);
    expect(readPayLock(file)?.pid).toBe(4242);
  });

  it("takes over a dead or expired holder's lock", () => {
    const file = lockFile();
    writeFileSync(file, JSON.stringify({ pid: 2 ** 30, expiresAt: Date.now() + 60_000 }));
    expect(claimPayLock(file, process.pid, 60_000)).toBe(true);
    writeFileSync(file, JSON.stringify({ pid: process.pid, expiresAt: Date.now() - 1 }));
    expect(claimPayLock(file, 4242, 60_000)).toBe(true);
    expect(readPayLock(file)?.pid).toBe(4242);
  });

  it("refuses a lock someone is still writing", () => {
    const file = lockFile();
    writeFileSync(file, "");
    expect(claimPayLock(file, process.pid, 60_000)).toBe(false);
  });
});

describe("payExclusively", () => {
  const statusFile = () => join(mkdtempSync(join(tmpdir(), "handcart-pay-")), "pay_status.json");

  it("records an early failure as an error stage, then frees the lock", async () => {
    const file = statusFile();
    await expect(
      payExclusively(file, "Zepto", async () => {
        throw new HandcartError("amount to pay is ₹120, not ₹100\nmore detail");
      }),
    ).rejects.toThrow(/₹120/);
    expect(readPayStatus(file)).toMatchObject({ stage: "error", error: "amount to pay is ₹120, not ₹100" });
    expect(readPayLock(payLockFile(file))).toBeUndefined();
  });

  it("keeps the error a run already recorded", async () => {
    const file = statusFile();
    await expect(
      payExclusively(file, "Zepto", async () => {
        writePayStatus({ stage: "error", error: "QR for ₹5", orderId: 42 }, file);
        throw new Error("QR for ₹5");
      }),
    ).rejects.toThrow();
    expect(readPayStatus(file)).toMatchObject({ stage: "error", orderId: 42 });
  });

  it("refuses a second run while the first holds the lock", async () => {
    const file = statusFile();
    let release = () => {};
    // Like a real run, it ends by writing its outcome.
    const first = payExclusively(
      file,
      "Zepto",
      () =>
        new Promise<string>((r) => {
          release = () => r(writePayStatus({ stage: "paid" }, file).stage);
        }),
    );
    await expect(payExclusively(file, "Zepto", async () => "again")).rejects.toThrow(/already in progress/);
    release();
    await expect(first).resolves.toBe("paid");
    await expect(payExclusively(file, "Zepto", async () => "next")).resolves.toBe("next");
  });
});
