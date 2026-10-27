/**
 * One pay run per platform at a time. Every run places its own order and hands out its own QR, so a
 * retried or concurrent `pay` could charge twice. A run holds `<status file>.lock` ({pid, expiresAt})
 * while it lives; a lock whose process is gone, or that is past its expiry (the pid was reused), holds
 * nothing, so a crashed run can't block payments for good.
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HandcartError } from "../core/errors.js";
import { readJson, writeJson } from "../core/storage.js";
import { type PayStatus, readPayStatus, writePayStatus } from "./status.js";

export interface PayLock {
  pid: number;
  expiresAt: number;
}

/** How long a QR with no known expiry counts as payable: the default pay timeout. */
const QR_GRACE_MS = 600_000;
/** A run that wrote "starting"/"launching" without any lock (an older version) counts as alive this long. */
const STARTUP_MS = 120_000;

export const payLockFile = (statusFile: string) => `${statusFile}.lock`;

/** Lock lifetime for a run that waits `timeoutSec` for payment, with room for launching and handoff. */
export const payLockTtlMs = (timeoutSec = 600) => (timeoutSec + 900) * 1000;

/** Whether `pid` is a running process (EPERM: running, just not ours). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const readPayLock = (file: string): PayLock | undefined => {
  const lock = readJson<PayLock>(file);
  return Number.isInteger(lock?.pid) && Number.isFinite(lock?.expiresAt) ? lock : undefined;
};

export const lockHeld = (lock: PayLock | undefined, now = Date.now(), isAlive = alive): boolean =>
  !!lock && now < lock.expiresAt && isAlive(lock.pid);

export interface BusyOptions {
  now?: number;
  isAlive?: (pid: number) => boolean;
  /** A pid whose lock is this run's own: the MCP server holds the lock for the child it spawns. */
  heir?: number;
}

/** Why a new pay run must not start, or null. `lock` is the lock file as read before claiming it. */
export function payBusy(status: PayStatus, lock: PayLock | undefined, opts: BusyOptions = {}): string | null {
  const { now = Date.now(), isAlive = alive, heir } = opts;
  if (lock && lock.pid !== heir && lockHeld(lock, now, isAlive)) {
    return `a payment is already in progress (stage ${status.stage})`;
  }
  // The run is gone but handed out a QR that may still be paid: a second order could charge twice.
  if (status.stage === "qr_ready") {
    const until = status.qrExpiresAt ?? status.ts + QR_GRACE_MS;
    return now < until ? `the last payment's QR can still be paid until ${new Date(until).toLocaleTimeString()}` : null;
  }
  if ((status.stage === "starting" || status.stage === "launching") && !lock && now - status.ts < STARTUP_MS) {
    return `a payment is already in progress (stage ${status.stage})`;
  }
  return null;
}

/**
 * Take the lock for `pid` until `ttlMs` from now; false if another live run holds it. A dead or
 * expired holder's lock is taken over, as is `heir`'s (see BusyOptions).
 */
export function claimPayLock(file: string, pid: number, ttlMs: number, heir?: number): boolean {
  const lock: PayLock = { pid, expiresAt: Date.now() + ttlMs };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      // wx: exactly one of two racing claimants creates the file.
      writeFileSync(file, JSON.stringify(lock), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = readPayLock(file);
    if (held && heir != null && held.pid === heir) {
      writeJson(file, lock);
      return true;
    }
    if (held ? lockHeld(held) : recentlyWritten(file)) return false;
    rmSync(file, { force: true });
  }
  return false;
}

/** Drop the lock, if `pid` still holds it. */
export function releasePayLock(file: string, pid: number): void {
  if (readPayLock(file)?.pid === pid) rmSync(file, { force: true });
}

/** An unreadable lock may be one another claimant is still writing. */
function recentlyWritten(file: string): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs < 5000;
  } catch {
    return false;
  }
}

/**
 * Run one pay attempt (the CLI `pay`) holding the platform's lock, and record any failure in its status
 * file: the MCP tool's child runs detached with no output, so `pay_status` is the only place its error
 * can show up. `label` names the store in the refusal.
 */
export async function payExclusively<T>(
  statusFile: string,
  label: string,
  pay: () => Promise<T>,
  timeoutSec?: number,
): Promise<T> {
  const file = payLockFile(statusFile);
  // The MCP server takes the lock before spawning this run (its parent) and hands it over here.
  const why = payBusy(readPayStatus(statusFile), readPayLock(file), { heir: process.ppid });
  if (why || !claimPayLock(file, process.pid, payLockTtlMs(timeoutSec), process.ppid)) {
    throw new HandcartError(`${why ?? "a payment is already in progress"}; not starting another ${label} payment`);
  }
  try {
    writePayStatus({ stage: "starting" }, statusFile);
    return await pay();
  } catch (e) {
    // Keep a more specific error the run already recorded (with its order id, pay link…).
    const s = readPayStatus(statusFile);
    const error = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    if (s.stage !== "error") writePayStatus({ ...s, stage: "error", error }, statusFile);
    throw e;
  } finally {
    releasePayLock(file, process.pid);
  }
}
