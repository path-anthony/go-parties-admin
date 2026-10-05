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

export async function recordFailure(scope: string, ip: string | null | undefined, now = new Date()): Promise<void> {
  await prisma.loginFailure.create({ data: { scope, ipHash: ipHash(ip), failedAt: now } });
  // Housekeeping: nothing older than a day is ever read.
  await prisma.loginFailure.deleteMany({ where: { failedAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } } });
}
