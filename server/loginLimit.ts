import { prisma } from "./db.js";
import { ipHash } from "./log.js";

// A failed-login counter kept in the database, so a deploy (which restarts the
// process and wipes any in-memory counter) does not hand an attacker a fresh
// five tries. Failures are stored against a keyed hash of the address, never
// the address.

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;

export async function recentFailures(scope: string, ip: string | null | undefined, now = new Date()): Promise<number> {
  return prisma.loginFailure.count({ where: { scope, ipHash: ipHash(ip), failedAt: { gt: new Date(now.getTime() - LOGIN_WINDOW_MS) } } });
}

export async function isLockedOut(scope: string, ip: string | null | undefined, now = new Date()): Promise<boolean> {
  return (await recentFailures(scope, ip, now)) >= LOGIN_MAX_FAILURES;
}

export type LoginAttempt = "ok" | "failed" | "locked";

// One login attempt: is this address locked out, does the password check out,
// and if not, keep the failure. The attempt is written down FIRST and the
// count taken second, so a burst of guesses sent at the same moment cannot
// slip past the limit: every attempt sees its own row plus every failure
// recorded before it looked, which means at most five wrong guesses are ever
// compared in a window, however they are timed. (Checking the count first and
// recording afterwards would let the whole burst through before any failure
// was written.) An attempt that is refused, or that succeeds, removes its own
// row again: only wrong passwords count, and being locked out does not extend
// the lockout. No transaction is held open, so a burst cannot tie up the
// database either. `check` must be quick and must not touch the database.
export async function attemptLogin(scope: string, ip: string | null | undefined, check: () => boolean, now = new Date()): Promise<LoginAttempt> {
  const key = ipHash(ip);
  const mine = await prisma.loginFailure.create({ data: { scope, ipHash: key, failedAt: now }, select: { id: true } });
  const inWindow = await prisma.loginFailure.count({ where: { scope, ipHash: key, failedAt: { gt: new Date(now.getTime() - LOGIN_WINDOW_MS) } } });
  const forget = () => prisma.loginFailure.deleteMany({ where: { id: mine.id } });
  if (inWindow > LOGIN_MAX_FAILURES) {
    await forget();
    return "locked";
  }
  if (check()) {
    await forget();
    return "ok";
  }
  // Housekeeping: nothing older than a day is ever read.
  await prisma.loginFailure.deleteMany({ where: { failedAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } } }).catch(() => undefined);
  return "failed";
}
