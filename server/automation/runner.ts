import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { safeErr } from "../log.js";
import { sendTemplatedMessage } from "../sendTemplated.js";
import { findExpiredHolds, releaseExpiredHolds, type HoldRelease } from "../holds.js";
import { loadPlans, type Journey, type Planned } from "./loaders.js";
import { channelWord, itemName, type PlanItem } from "./planner.js";
import { humanWhen } from "./time.js";

// One pass of the scheduler. The hourly n8n call and the admin's
// "Run check now" both come through runAutomation, so a preview shows
// exactly what the real run will do.
//
// Safe to run twice in a row or after a missed hour: the planner decides
// what is due (catching up only what still makes sense), and the send
// pipeline's idempotency key makes a repeat a no-op.

export type RunLine = {
  journey: Journey;
  kind: string;
  recordId: string;
  name: string;
  href: string;
  trigger: string;
  what: string;
  channel: string;
  dueAt: string;
  // dry run: "would send" / "would log blocked" ; real run: the outcome.
  result: string;
  reason?: string;
};

export type Counts = { records: number; due: number; sent: number; failed: number; blocked: number; skipped: number; other: number };

export type RunResult = {
  dryRun: boolean;
  ranAt: string;
  durationMs: number;
  counts: Record<Journey, Counts> & { total: Counts };
  lines: RunLine[];
  needsAttention: number;
  // Unpaid storefront holds past the limit: released on a real run, listed on a dry run.
  holds: { days: number; released: HoldRelease[]; dryRun: boolean };
};

const empty = (): Counts => ({ records: 0, due: 0, sent: 0, failed: 0, blocked: 0, skipped: 0, other: 0 });

function bucket(status: string): keyof Counts {
  if (status === "sent") return "sent";
  if (status === "failed" || status === "failed_final") return "failed";
  if (status === "blocked_missing_field") return "blocked";
  if (status.startsWith("skipped")) return "skipped";
  return "other";
}

// Items the run acts on: everything due, plus blocked or opted-out ones that
// have no log row yet (so the log shows why nothing went).
const actionable = (i: PlanItem) => i.state === "due" || (i.record === true && (i.state === "blocked" || i.code === "opted_out"));

export async function countNeedsAttention(): Promise<number> {
  const account = await getDefaultAccount();
  return prisma.messageLog.count({ where: { accountId: account.id, status: "failed_final" } });
}

export async function runAutomation(opts: { dryRun: boolean; source: "n8n" | "admin"; now?: Date; windowDays?: number }): Promise<RunResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const planned = await loadPlans({ now, windowDays: opts.windowDays });
  const counts = { lead: empty(), client: empty(), crew: empty(), total: empty() };
  const lines: RunLine[] = [];

  for (const rec of planned) {
    if (rec.plan.items.length > 0) counts[rec.journey].records++;
    for (const item of rec.plan.items.filter(actionable)) {
      const line: RunLine = {
        journey: rec.journey,
        kind: rec.kind,
        recordId: rec.recordId,
        name: rec.name,
        href: rec.href,
        trigger: item.triggerKey,
        what: itemName(item),
        channel: item.channel,
        dueAt: item.dueAt.toISOString(),
        result: "",
        reason: item.reason,
      };
      if (item.state === "due") counts[rec.journey].due++;
      if (opts.dryRun) {
        line.result = item.state === "due" ? "would send" : item.state === "blocked" ? "would log as blocked" : "would log as skipped (opted out)";
      } else {
        const status = await sendItem(rec, item, now);
        line.result = status.status;
        line.reason = status.error ?? item.reason;
        counts[rec.journey][bucket(status.status)]++;
      }
      lines.push(line);
    }
  }
  for (const j of ["lead", "client", "crew"] as const) {
    for (const k of Object.keys(counts.total) as (keyof Counts)[]) counts.total[k] += counts[j][k];
  }

  const holds = opts.dryRun ? { ...(await findExpiredHolds(now)), dryRun: true } : { ...(await releaseExpiredHolds(now)), dryRun: false };
  const holdsOut = { days: holds.days, released: "holds" in holds ? holds.holds : holds.released, dryRun: holds.dryRun };
  const result: RunResult = { dryRun: opts.dryRun, ranAt: now.toISOString(), durationMs: Date.now() - started, counts, lines, needsAttention: await countNeedsAttention(), holds: holdsOut };
  if (!opts.dryRun) {
    const account = await getDefaultAccount();
    await prisma.automationRun.create({
      data: {
        accountId: account.id,
        source: opts.source,
        durationMs: result.durationMs,
        summary: { counts: result.counts, lines: result.lines.length, needsAttention: result.needsAttention, holdsReleased: result.holds.released.length },
      },
    });
  }
  return result;
}

async function sendItem(rec: Planned, item: PlanItem, now: Date): Promise<{ status: string; error?: string }> {
  try {
    const recipient = item.channel === "sms" ? { phone: rec.contact.phone ?? "" } : { email: rec.contact.email ?? "" };
    const purpose = item.triggerKey === "balance_due_reminder" ? "balance-reminder" : item.triggerKey;
    const outcomes = await sendTemplatedMessage(item.triggerKey, rec.send.context, recipient, item.baseKey, { channels: [item.channel], purpose, now });
    const o = outcomes.find((x) => x.channel === item.channel);
    if (!o) return { status: "not-sent" };
    if (o.status === "sent" && item.triggerKey === "balance_due_reminder") {
      await prisma.booking.update({ where: { id: rec.recordId }, data: { lastBalanceReminderAt: now } });
    }
    return { status: o.status, error: o.error };
  } catch (err) {
    console.error(`[automation] ${item.triggerKey} for ${rec.kind} ${rec.recordId} failed:`, safeErr(err));
    return { status: "failed", error: err instanceof Error ? err.message : "unexpected error" };
  }
}

// ---- Views -------------------------------------------------------------

export type UpcomingEntry = {
  journey: Journey;
  kind: string;
  recordId: string;
  name: string;
  href: string;
  what: string;
  channel: string;
  sendAt: string;
  when: string;
  state: string;
  reason?: string;
};

// The next `days` days of planned sends (plus anything due right now),
// soonest first. Blocked messages are included with their reason, well
// before they would have gone.
export async function upcomingView(days = 14, now = new Date()): Promise<{ entries: UpcomingEntry[]; needsAttention: number; failed: FailedEntry[] }> {
  const planned = await loadPlans({ now });
  const horizon = now.getTime() + days * 86_400_000;
  const entries: UpcomingEntry[] = [];
  for (const rec of planned) {
    for (const i of rec.plan.items) {
      if (!(i.state === "scheduled" || i.state === "due" || i.state === "blocked")) continue;
      if (i.sendAt.getTime() > horizon) continue;
      entries.push({
        journey: rec.journey,
        kind: rec.kind,
        recordId: rec.recordId,
        name: rec.name,
        href: rec.href,
        what: `${itemName(i)}`,
        channel: channelWord(i.channel),
        sendAt: i.sendAt.toISOString(),
        when: humanWhen(i.sendAt),
        state: i.state,
        reason: i.reason,
      });
    }
  }
  entries.sort((a, b) => a.sendAt.localeCompare(b.sendAt));
  const account = await getDefaultAccount();
  const failedRows = await prisma.messageLog.findMany({ where: { accountId: account.id, status: "failed_final" }, orderBy: { createdAt: "desc" }, take: 50 });
  const failed: FailedEntry[] = failedRows.map((r) => ({
    id: r.id,
    triggerKey: r.triggerKey,
    channel: r.channel,
    recipient: r.recipient,
    error: r.error,
    at: (r.sentAt ?? r.createdAt).toISOString(),
    href: r.leadId ? `/leads?lead=${r.leadId}` : r.gigId ? `/crew/gigs?gig=${r.gigId}` : r.bookingId ? `/scheduling/bookings?booking=${r.bookingId}` : null,
  }));
  return { entries, needsAttention: await countNeedsAttention(), failed };
}

export type FailedEntry = { id: string; triggerKey: string | null; channel: string; recipient: string; error: string | null; at: string; href: string | null };
