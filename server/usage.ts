import { prisma } from "./db.js";
import { todayEastern } from "./validate.js";

// Per-day counters kept in the database, so a deploy does not hand the
// public a fresh budget. One row per account, key and Eastern day.

export type UsageKey = "ai_public" | "ai_admin" | "direct_booking";

// Takes one unit if today's count is still under `cap`. Returns false (and
// takes nothing) once the cap is reached. Atomic: two requests racing for the
// last unit cannot both get it.
export async function takeDaily(accountId: string, key: UsageKey, cap: number, now = new Date()): Promise<boolean> {
  if (cap <= 0) return false;
  const day = todayEastern(now);
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO usage_counters (id, account_id, key, day, count)
    VALUES (${`uc_${accountId}_${key}_${day}`}, ${accountId}, ${key}, ${day}, 1)
    ON CONFLICT (account_id, key, day) DO UPDATE SET count = usage_counters.count + 1
    WHERE usage_counters.count < ${cap}
    RETURNING count`;
  return rows.length > 0;
}

// Counts a use that is not limited (admin AI calls), for visibility only.
export async function bumpDaily(accountId: string, key: UsageKey, now = new Date()): Promise<void> {
  const day = todayEastern(now);
  await prisma.$executeRaw`
    INSERT INTO usage_counters (id, account_id, key, day, count)
    VALUES (${`uc_${accountId}_${key}_${day}`}, ${accountId}, ${key}, ${day}, 1)
    ON CONFLICT (account_id, key, day) DO UPDATE SET count = usage_counters.count + 1`;
}

export async function usedToday(accountId: string, key: UsageKey, now = new Date()): Promise<number> {
  const row = await prisma.usageCounter.findUnique({ where: { accountId_key_day: { accountId, key, day: todayEastern(now) } } });
  return row?.count ?? 0;
}
