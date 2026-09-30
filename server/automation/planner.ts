import { isLostStage, isWonStage } from "../../src/lib/leadStages.js";
import { checkSendRules } from "../sendRules.js";
import { mustGetTrigger, type Channel } from "../triggers.js";
import { addDays, atEastern, easternDay, humanDay, humanWhen, skipSunday } from "./time.js";

// The one planner. Given a record and "now", it returns the whole schedule
// for that record: every message the automation would send, on which
// channel, when, and what state it is in (sent, scheduled, skipped,
// blocked, stopped, ...). It touches no database and no clock: everything
// it needs is in the record and in `Facts`, which the loaders fill from
// the database. The sender and every admin screen call this same function,
// so what the admin sees is what will happen.
//
// The rules that apply to every series:
//   catch-up      A message that is overdue goes only if the next message in
//                 its series is not yet due and the event has not started.
//                 Otherwise it is skipped as superseded. Nothing goes for a
//                 past event except post_event_thanks.
//   last message  The last message in a series is dropped when it would go
//                 more than 3 days late.
//   start         Nothing is sent for a moment before the record entered
//                 automation (the later of when it was created or accepted,
//                 and when the scheduler went live).
//   send window   A message waits for its send class's hours (texts 9 AM to
//                 8 PM Eastern, no follow-ups on Sunday).

export type PlanState =
  | "sent"
  | "scheduled" // will go at sendAt
  | "due" // goes on this run
  | "skipped" // will never go; see reason
  | "blocked" // cannot go until something is fixed; see reason
  | "stopped" // the journey ended for this record
  | "paused" // staff paused it
  | "waiting" // the record is not yet eligible
  | "failed_final";

export type SkipCode = "superseded" | "before_start" | "no_phone" | "no_email" | "opted_out" | "past_event";

export type PlanItem = {
  triggerKey: string;
  channel: Channel;
  seriesId: string;
  // Idempotency key without the channel suffix.
  baseKey: string;
  // The milestone as planned, and when it can actually go (later when it
  // has to wait for text hours).
  dueAt: Date;
  sendAt: Date;
  state: PlanState;
  reason?: string;
  code?: SkipCode;
  attempts: number;
  sentAt?: Date;
  // The run should log this even though it cannot go (a blocked message
  // that has no log row yet; an opted-out text).
  record?: boolean;
};

export type Plan = {
  enrolled: boolean;
  // Why the record is not in this journey at all.
  notEnrolled?: string;
  items: PlanItem[];
};

export type LogFact = { status: string; attempts: number; sentAt: Date | null; error: string | null };

export type Facts = {
  now: Date;
  // The scheduler went live at this moment; nothing earlier is sent.
  automationStartedAt: Date;
  // The log row for a base key on a channel, if any.
  log(baseKey: string, channel: Channel): LogFact | undefined;
  // Whether the message is switched on for the channel.
  channelOn(triggerKey: string, channel: Channel): boolean;
  optedOut(phone: string): boolean;
  // Why the message would come out blocked (empty merge tokens), or null.
  blockedReason(triggerKey: string, channel: Channel, subject: PlanSubject): string | null;
};

// Identifies which record a blockedReason question is about.
export type PlanSubject = { kind: "lead" | "booking" | "gig"; id: string };

export type Contact = { phone: string | null; email: string | null };

export const MAX_ATTEMPTS = 3;
export const LATE_CAP_MS = 72 * 3_600_000;
const CHANNELS: Channel[] = ["sms", "email"];

type Milestone = { triggerKey: string; dueAt: Date; baseKey: string; allowPastEvent?: boolean; skip?: string | null };

type SeriesInput = {
  id: string;
  subject: PlanSubject;
  milestones: Milestone[];
  recordStart: Date;
  contact: Contact;
  paused: boolean;
  // Unsent messages become "stopped" with this reason.
  stopped?: string | null;
  // Unsent messages become "waiting" with this reason.
  waiting?: string | null;
  // The event day begins here; from then on only allowPastEvent messages go.
  eventStart?: Date | null;
};

// The first moment at or after `from` when this kind of message may go.
export function nextAllowed(triggerKey: string, channel: Channel, from: Date): Date {
  const cls = mustGetTrigger(triggerKey).sendClass;
  let t = from;
  for (let i = 0; i < 20; i++) {
    const d = checkSendRules(cls, channel, t);
    if (d.allowed) return t;
    const day = easternDay(t);
    // Before 9 AM: today at 9. After 8 PM, or a Sunday: the next day at 9.
    const early = d.status === "deferred_quiet_hours" && t < atEastern(day, 9);
    t = atEastern(early ? day : addDays(day, 1), 9);
  }
  return t;
}

function planSeries(s: SeriesInput, f: Facts): PlanItem[] {
  const start = new Date(Math.max(s.recordStart.getTime(), f.automationStartedAt.getTime()));
  const ms = [...s.milestones].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  const out: PlanItem[] = [];

  ms.forEach((m, i) => {
    for (const channel of CHANNELS) {
      if (!f.channelOn(m.triggerKey, channel)) continue;
      const item: PlanItem = { triggerKey: m.triggerKey, channel, seriesId: s.id, baseKey: m.baseKey, dueAt: m.dueAt, sendAt: m.dueAt, state: "scheduled", attempts: 0 };
      out.push(item);

      const log = f.log(m.baseKey, channel);
      if (log) {
        item.attempts = log.attempts;
        if (log.status === "sent" || log.status === "queued") {
          item.state = "sent";
          item.sentAt = log.sentAt ?? undefined;
          continue;
        }
        if (log.status === "failed_final" || (log.status === "failed" && log.attempts >= MAX_ATTEMPTS)) {
          item.state = "failed_final";
          item.reason = log.error ?? "The send failed 3 times.";
          continue;
        }
        if (log.status === "skipped_opted_out") {
          item.state = "skipped";
          item.code = "opted_out";
          item.reason = "This number opted out of texts.";
          continue;
        }
      }

      if (s.stopped) {
        Object.assign(item, { state: "stopped", reason: s.stopped });
        continue;
      }
      if (s.paused) {
        Object.assign(item, { state: "paused", reason: "Paused by staff" });
        continue;
      }
      if (s.waiting) {
        Object.assign(item, { state: "waiting", reason: s.waiting });
        continue;
      }
      if (m.skip) {
        Object.assign(item, { state: "skipped", code: "superseded" as SkipCode, reason: m.skip });
        continue;
      }
      if (m.dueAt < start) {
        Object.assign(item, { state: "skipped", code: "before_start", reason: "This point had already passed when the record entered automation." });
        continue;
      }

      item.sendAt = nextAllowed(m.triggerKey, channel, new Date(Math.max(m.dueAt.getTime(), f.now.getTime())));
      const sendAt = item.sendAt;

      if (s.eventStart && !m.allowPastEvent && sendAt >= s.eventStart) {
        Object.assign(item, { state: "skipped", code: "past_event", reason: "The event has already started." });
        continue;
      }
      const next = ms[i + 1];
      if (next && next.dueAt <= sendAt) {
        Object.assign(item, { state: "skipped", code: "superseded", reason: "The next reminder is already due, so this one was dropped." });
        continue;
      }
      if (!next && sendAt.getTime() - m.dueAt.getTime() > LATE_CAP_MS) {
        Object.assign(item, { state: "skipped", code: "superseded", reason: "It would go more than 3 days late, so it was dropped." });
        continue;
      }

      if (channel === "sms") {
        if (!s.contact.phone) {
          Object.assign(item, { state: "skipped", code: "no_phone", reason: "No phone number on file." });
          continue;
        }
        if (f.optedOut(s.contact.phone)) {
          Object.assign(item, { state: "skipped", code: "opted_out", reason: "This number opted out of texts.", record: sendAt <= f.now });
          continue;
        }
      } else if (!s.contact.email) {
        Object.assign(item, { state: "skipped", code: "no_email", reason: "No email address on file." });
        continue;
      }

      const blocked = f.blockedReason(m.triggerKey, channel, s.subject);
      if (blocked) {
        Object.assign(item, { state: "blocked", reason: blocked, record: sendAt <= f.now && !log });
        continue;
      }
      item.state = sendAt <= f.now ? "due" : "scheduled";
    }
  });
  return out;
}

// ---- Journey 1: lead nurture ------------------------------------------

// Only leads entered by hand are followed up. Everything else has its own
// campaign somewhere else (or none) and must never get these texts.
export const NURTURE_SOURCES = ["manual"];

const SOURCE_LABEL: Record<string, string> = { website: "website", storefront: "storefront", "ask-go": "Ask GO", concierge: "concierge" };

export type LeadInput = {
  id: string;
  source: string;
  createdAt: Date;
  // The Leads board column the lead is in.
  stage: string;
  hasBooking: boolean;
  paused: boolean;
  dateOfInterest: string | null;
  contact: Contact;
};

export function planLead(lead: LeadInput, f: Facts): Plan {
  if (!NURTURE_SOURCES.includes(lead.source)) {
    return { enrolled: false, notEnrolled: `Not in nurture: ${SOURCE_LABEL[lead.source] ?? lead.source} lead`, items: [] };
  }
  const base = easternDay(lead.createdAt);
  const milestones: Milestone[] = [
    { triggerKey: "lead_nurture_day3", n: 3 },
    { triggerKey: "lead_nurture_day10", n: 10 },
  ].map(({ triggerKey, n }) => ({ triggerKey, dueAt: atEastern(skipSunday(addDays(base, n)), 10), baseKey: `${triggerKey}:${lead.id}` }));

  const stopped = lead.hasBooking
    ? "Stopped: booked"
    : isWonStage(lead.stage)
      ? "Stopped: moved to Booked"
      : isLostStage(lead.stage)
        ? "Stopped: marked Lost"
        : null;
  const items = planSeries(
    {
      id: "lead_nurture",
      subject: { kind: "lead", id: lead.id },
      milestones,
      recordStart: lead.createdAt,
      contact: lead.contact,
      paused: lead.paused,
      stopped,
      eventStart: lead.dateOfInterest ? atEastern(lead.dateOfInterest, 0) : null,
    },
    f,
  );
  return { enrolled: true, items };
}

// ---- Journey 2: client -------------------------------------------------

export type BookingInput = {
  id: string;
  createdAt: Date;
  eventDate: string; // YYYY-MM-DD
  stage: string; // stored stage
  retainerPaid: boolean;
  balancePaid: boolean;
  total: number | null;
  balancePref: string;
  paused: boolean;
  lastBalanceReminderAt: Date | null;
  contact: Contact;
  // The contract, if one was sent.
  contract: { sentAt: Date | null; signed: boolean } | null;
  balanceWindowDays: number;
};

const NUDGE_AFTER_MS = 48 * 3_600_000;
const BALANCE_EVERY_DAYS = 3;

export function planBooking(b: BookingInput, f: Facts): Plan {
  const subject: PlanSubject = { kind: "booking", id: b.id };
  const cancelled = b.stage === "Cancelled";
  const completed = b.stage === "Completed";
  const eventStart = atEastern(b.eventDate, 0);
  const at10 = (offset: number) => atEastern(addDays(b.eventDate, offset), 10);
  const items: PlanItem[] = [];

  // Contract nudge: 48 hours after the signing link went out, if unsigned.
  if (b.contract?.sentAt) {
    const stopped = cancelled ? "Booking cancelled" : b.contract.signed ? "Stopped: contract signed" : completed ? "Booking completed" : null;
    items.push(
      ...planSeries(
        {
          id: "contract",
          subject,
          milestones: [{ triggerKey: "contract_unsigned_nudge", dueAt: new Date(b.contract.sentAt.getTime() + NUDGE_AFTER_MS), baseKey: `contract_unsigned_nudge:${b.id}` }],
          recordStart: b.contract.sentAt,
          contact: b.contact,
          paused: b.paused,
          stopped,
          eventStart,
        },
        f,
      ),
    );
  }

  // Event reminders: only once the retainer is paid (Retainer Paid or
  // Confirmed). Nothing for a cancelled booking. The thank-you also goes
  // for a booking staff marked Completed.
  const live = b.retainerPaid && !cancelled && !completed;
  const eventKey = (t: string) => `${t}:${b.id}:${b.eventDate}`;
  const eventMilestones: Milestone[] = [
    { triggerKey: "event_week_reminder", dueAt: at10(-7), baseKey: eventKey("event_week_reminder") },
    { triggerKey: "event_eve_reminder", dueAt: at10(-1), baseKey: eventKey("event_eve_reminder") },
    { triggerKey: "post_event_thanks", dueAt: at10(1), baseKey: eventKey("post_event_thanks"), allowPastEvent: true },
  ];
  const eventWaiting = live || completed ? null : "Starts once the retainer is paid.";
  // A completed booking only gets the thank-you; a cancelled one gets nothing.
  const mask = (ms: Milestone[]) => (completed ? ms.map((m) => (m.allowPastEvent ? m : { ...m, skip: "The booking is marked Completed." })) : ms);
  items.push(
    ...planSeries(
      { id: "event", subject, milestones: mask(eventMilestones), recordStart: b.createdAt, contact: b.contact, paused: b.paused, stopped: cancelled ? "Booking cancelled" : null, waiting: eventWaiting, eventStart },
      f,
    ),
  );

  // Balance reminders: from `balanceWindowDays` before the event, every 3
  // days, at 10 AM, while a balance is open. Auto-charge is left alone.
  const balMilestones: Milestone[] = [];
  const firstOffset = -Math.max(0, b.balanceWindowDays);
  for (let off = firstOffset; off <= 0; off += BALANCE_EVERY_DAYS) {
    const day = addDays(b.eventDate, off);
    const recentlyReminded = b.lastBalanceReminderAt && (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${easternDay(b.lastBalanceReminderAt)}T00:00:00Z`)) / 86_400_000 < BALANCE_EVERY_DAYS && b.lastBalanceReminderAt < atEastern(day, 10);
    balMilestones.push({ triggerKey: "balance_due_reminder", dueAt: atEastern(day, 10), baseKey: `balance_due_reminder:${b.id}:${day}`, skip: recentlyReminded ? "A balance reminder went out in the last 3 days." : null });
  }
  const balStopped = cancelled
    ? "Booking cancelled"
    : completed
      ? "Booking completed"
      : b.balancePaid
        ? "Stopped: balance paid"
        : b.total === null
          ? "No total on this booking yet."
          : b.balancePref === "Auto-charge"
            ? "Balance is set to auto-charge."
            : null;
  items.push(
    ...planSeries(
      { id: "balance", subject, milestones: balMilestones, recordStart: b.createdAt, contact: b.contact, paused: b.paused, stopped: balStopped, waiting: b.retainerPaid ? null : "Starts once the retainer is paid.", eventStart },
      f,
    ),
  );
  return { enrolled: true, items };
}

// ---- Journey 3: crew ----------------------------------------------------

export type GigInput = {
  gigId: string;
  crewMemberId: string;
  eventDate: string;
  // When the offer was accepted; reminders before it are skipped.
  acceptedAt: Date;
  offerStatus: string;
  gigStatus: string;
  paused: boolean;
  contact: Contact;
};

export const CREW_STEPS = [
  { key: "crew_reminder_30", days: 30, hour: 10 },
  { key: "crew_reminder_15", days: 15, hour: 10 },
  { key: "crew_reminder_7", days: 7, hour: 10 },
  { key: "crew_reminder_3", days: 3, hour: 10 },
  { key: "crew_reminder_eve", days: 1, hour: 18 },
] as const;

export function planGig(g: GigInput, f: Facts): Plan {
  const milestones: Milestone[] = CREW_STEPS.map((s) => ({
    triggerKey: s.key,
    dueAt: atEastern(addDays(g.eventDate, -s.days), s.hour),
    baseKey: `${s.key}:${g.gigId}:${g.crewMemberId}:${g.eventDate}`,
  }));
  const stopped = g.gigStatus === "Cancelled" ? "Stopped: gig cancelled" : g.offerStatus !== "Accepted" ? "Stopped: offer is no longer accepted" : null;
  const items = planSeries(
    { id: "crew", subject: { kind: "gig", id: g.gigId }, milestones, recordStart: g.acceptedAt, contact: g.contact, paused: g.paused, stopped, eventStart: atEastern(g.eventDate, 0) },
    f,
  );
  return { enrolled: true, items };
}

// ---- Plain English -------------------------------------------------------

const NAMES: Record<string, string> = {
  lead_nurture_day3: "day 3 follow-up",
  lead_nurture_day10: "day 10 follow-up",
  contract_unsigned_nudge: "contract reminder",
  balance_due_reminder: "balance reminder",
  event_week_reminder: "event week reminder",
  event_eve_reminder: "event eve reminder",
  post_event_thanks: "thank-you",
  crew_reminder_30: "30 day gig reminder",
  crew_reminder_15: "15 day gig reminder",
  crew_reminder_7: "7 day gig reminder",
  crew_reminder_3: "3 day gig reminder",
  crew_reminder_eve: "day-before gig reminder",
};

export const triggerName = (key: string) => NAMES[key] ?? key;
export const channelWord = (c: Channel) => (c === "sms" ? "text" : "email");

// "event week text"
export const itemName = (i: PlanItem) => `${triggerName(i.triggerKey)} ${channelWord(i.channel)}`;

// Items that are still to come, soonest first.
export function upcoming(plan: Plan): PlanItem[] {
  return plan.items.filter((i) => i.state === "scheduled" || i.state === "due" || i.state === "blocked").sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
}

// "Next: event week text, Tue, Oct 7 at 10:00 AM", or why there is none.
export function nextLine(plan: Plan): string {
  if (!plan.enrolled) return plan.notEnrolled ?? "Not in an automated journey.";
  const stopped = plan.items.find((i) => i.state === "stopped");
  if (stopped) return stopped.reason ?? "Stopped";
  const paused = plan.items.find((i) => i.state === "paused");
  if (paused) return "Paused by staff";
  const n = upcoming(plan)[0];
  if (n) return `Next: ${itemName(n)}, ${humanWhen(n.sendAt)}${n.state === "blocked" ? " (blocked)" : ""}`;
  const waiting = plan.items.find((i) => i.state === "waiting");
  if (waiting) return waiting.reason ?? "Waiting";
  return "Nothing more planned.";
}

// The chip on the Leads list.
export function leadChip(plan: Plan): string {
  if (!plan.enrolled) return plan.notEnrolled ?? "Not in nurture";
  const stopped = plan.items.find((i) => i.state === "stopped");
  if (stopped) return stopped.reason ?? "Stopped";
  if (plan.items.some((i) => i.state === "paused")) return "Paused";
  const sent = plan.items.filter((i) => i.state === "sent").sort((a, b) => b.dueAt.getTime() - a.dueAt.getTime())[0];
  const next = upcoming(plan)[0];
  const sentText = sent ? `${triggerName(sent.triggerKey).replace(" follow-up", "").replace(/^d/, "D")} sent` : null;
  const nextText = next ? `next ${humanDay(next.sendAt).replace(/^\w+, /, "")}` : null;
  if (sentText && nextText) return `${sentText}, ${nextText}`;
  if (sentText) return sentText;
  if (nextText) return `Day ${next!.triggerKey.endsWith("10") ? 10 : 3} ${nextText.replace("next", "on")}`;
  return "Nothing more planned";
}
