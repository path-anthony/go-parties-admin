import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atEastern, easternDay, skipSunday } from "../automation/time.js";
import { planBooking, planGig, planLead, type BookingInput, type Facts, type GigInput, type LeadInput, type LogFact, type PlanItem } from "../automation/planner.js";
import type { Channel } from "../triggers.js";

const START = new Date("2026-01-01T00:00:00Z");

function facts(now: Date, opts: { logs?: Record<string, LogFact>; off?: string[]; optedOut?: string[]; blocked?: Record<string, string> } = {}): Facts {
  return {
    now,
    automationStartedAt: START,
    log: (k, c) => opts.logs?.[`${k}:${c}`],
    // Text on for everything; email only where the registry defaults it on.
    channelOn: (t, c) => !opts.off?.includes(`${t}:${c}`) && (c === "sms" || ["contract_unsigned_nudge", "balance_due_reminder", "event_week_reminder", "event_eve_reminder", "post_event_thanks"].includes(t)),
    optedOut: (p) => opts.optedOut?.includes(p) ?? false,
    blockedReason: (t, c) => opts.blocked?.[`${t}:${c}`] ?? null,
  };
}

const contact = { phone: "+15555550100", email: "a@example.com" };
const et = (day: string, h: number, m = 0) => atEastern(day, h, m);
const byTrigger = (items: PlanItem[], t: string, c: Channel = "sms") => items.find((i) => i.triggerKey === t && i.channel === c)!;

const lead = (over: Partial<LeadInput> = {}): LeadInput => ({ id: "L1", source: "manual", createdAt: et("2026-10-05", 14), stage: "New", hasBooking: false, paused: false, dateOfInterest: null, contact, ...over });

describe("time", () => {
  it("converts Eastern wall clock across daylight saving", () => {
    assert.equal(atEastern("2026-07-01", 10).toISOString(), "2026-07-01T14:00:00.000Z");
    assert.equal(atEastern("2026-12-01", 10).toISOString(), "2026-12-01T15:00:00.000Z");
    // Spring forward 2026-03-08 and fall back 2026-11-01.
    assert.equal(atEastern("2026-03-08", 10).toISOString(), "2026-03-08T14:00:00.000Z");
    assert.equal(atEastern("2026-03-07", 10).toISOString(), "2026-03-07T15:00:00.000Z");
    assert.equal(atEastern("2026-11-01", 10).toISOString(), "2026-11-01T15:00:00.000Z");
    assert.equal(easternDay(new Date("2026-11-01T04:30:00Z")), "2026-11-01");
  });
  it("moves Sunday to Monday", () => {
    assert.equal(skipSunday("2026-10-11"), "2026-10-12");
    assert.equal(skipSunday("2026-10-12"), "2026-10-12");
  });
});

describe("lead nurture", () => {
  it("plans day 3 and day 10 at 10 AM Eastern", () => {
    const p = planLead(lead(), facts(et("2026-10-05", 15)));
    const d3 = byTrigger(p.items, "lead_nurture_day3");
    const d10 = byTrigger(p.items, "lead_nurture_day10");
    assert.equal(d3.dueAt.toISOString(), et("2026-10-08", 10).toISOString());
    assert.equal(d3.state, "scheduled");
    assert.equal(d10.dueAt.toISOString(), et("2026-10-15", 10).toISOString());
  });
  it("moves a Sunday due date to Monday 10 AM", () => {
    // Created Thursday Oct 8: day 3 = Sunday Oct 11 -> Monday Oct 12.
    const p = planLead(lead({ createdAt: et("2026-10-08", 9) }), facts(et("2026-10-09", 9)));
    assert.equal(byTrigger(p.items, "lead_nurture_day3").dueAt.toISOString(), et("2026-10-12", 10).toISOString());
  });
  it("only enrolls manual leads", () => {
    for (const source of ["website", "storefront", "ask-go", "concierge"]) {
      const p = planLead(lead({ source }), facts(et("2026-10-20", 10)));
      assert.equal(p.enrolled, false);
      assert.equal(p.items.length, 0);
    }
  });
  it("sends when due and marks sent from the log", () => {
    const now = et("2026-10-08", 10, 5);
    assert.equal(byTrigger(planLead(lead(), facts(now)).items, "lead_nurture_day3").state, "due");
    const sent = planLead(lead(), facts(now, { logs: { "lead_nurture_day3:L1:sms": { status: "sent", attempts: 1, sentAt: now, error: null } } }));
    assert.equal(byTrigger(sent.items, "lead_nurture_day3").state, "sent");
  });
  it("stops for a booking, the Booked column, the Lost column", () => {
    const now = et("2026-10-07", 10);
    assert.equal(planLead(lead({ hasBooking: true }), facts(now)).items[0].reason, "Stopped: booked");
    assert.equal(planLead(lead({ stage: "booked" }), facts(now)).items[0].state, "stopped");
    assert.equal(planLead(lead({ stage: "Lost" }), facts(now)).items[0].state, "stopped");
    assert.equal(planLead(lead({ stage: "Contacted" }), facts(now)).items[0].state, "scheduled");
  });
  it("shows paused", () => {
    assert.equal(planLead(lead({ paused: true }), facts(et("2026-10-07", 10))).items[0].state, "paused");
  });
  it("catch-up: day 3 dropped once day 10 is due; day 10 dropped after 3 days late", () => {
    const l = lead();
    const late = planLead(l, facts(et("2026-10-15", 11)));
    assert.equal(byTrigger(late.items, "lead_nurture_day3").code, "superseded");
    assert.equal(byTrigger(late.items, "lead_nurture_day10").state, "due");
    const tooLate = planLead(l, facts(et("2026-10-19", 11)));
    assert.equal(byTrigger(tooLate.items, "lead_nurture_day10").state, "skipped");
  });
  it("catch-up: an overdue day 3 still goes while day 10 is not yet due", () => {
    assert.equal(byTrigger(planLead(lead(), facts(et("2026-10-09", 12))).items, "lead_nurture_day3").state, "due");
  });
  it("nothing goes before automation started", () => {
    const old = lead({ createdAt: new Date("2025-06-01T12:00:00Z") });
    const p = planLead(old, facts(et("2026-10-07", 10)));
    assert.equal(byTrigger(p.items, "lead_nurture_day3").code, "before_start");
  });
  it("waits for text hours and never texts on Sunday", () => {
    // Overdue day 3 found at 9:30 PM Saturday: next window is Monday 9 AM (Sunday is out).
    const p = planLead(lead({ createdAt: et("2026-10-01", 12) }), facts(et("2026-10-10", 21, 30)));
    const d3 = byTrigger(p.items, "lead_nurture_day3");
    assert.equal(d3.state, "scheduled");
    assert.equal(d3.sendAt.toISOString(), et("2026-10-12", 9).toISOString());
  });
  it("skips a missing phone and an opted-out number, keeps the other channel", () => {
    const now = et("2026-10-08", 10, 5);
    const noPhone = planLead(lead({ contact: { phone: null, email: "a@b.co" } }), facts(now));
    assert.equal(byTrigger(noPhone.items, "lead_nurture_day3").code, "no_phone");
    const opted = planLead(lead(), facts(now, { optedOut: ["+15555550100"] }));
    assert.equal(byTrigger(opted.items, "lead_nurture_day3").code, "opted_out");
    assert.equal(byTrigger(opted.items, "lead_nurture_day3").record, true);
  });
  it("drops follow-ups once the date of interest has passed", () => {
    const p = planLead(lead({ dateOfInterest: "2026-10-06" }), facts(et("2026-10-08", 10, 5)));
    assert.equal(byTrigger(p.items, "lead_nurture_day3").code, "past_event");
  });
});

const booking = (over: Partial<BookingInput> = {}): BookingInput => ({
  id: "B1", createdAt: et("2026-09-01", 12), eventDate: "2026-10-20", stage: "Signed", retainerPaid: true, balancePaid: false, total: 1000, balancePref: "Manual",
  paused: false, lastBalanceReminderAt: null, contact, contract: null, balanceWindowDays: 7, ...over,
});

describe("client journey", () => {
  it("plans week, eve and thanks at 10 AM", () => {
    const p = planBooking(booking(), facts(et("2026-10-01", 9)));
    assert.equal(byTrigger(p.items, "event_week_reminder").dueAt.toISOString(), et("2026-10-13", 10).toISOString());
    assert.equal(byTrigger(p.items, "event_eve_reminder").dueAt.toISOString(), et("2026-10-19", 10).toISOString());
    assert.equal(byTrigger(p.items, "post_event_thanks").dueAt.toISOString(), et("2026-10-21", 10).toISOString());
    // Email is on by default for these, so both channels are planned.
    assert.ok(byTrigger(p.items, "event_week_reminder", "email"));
  });
  it("waits until the retainer is paid; nothing for cancelled", () => {
    const held = planBooking(booking({ stage: "Held", retainerPaid: false }), facts(et("2026-10-01", 9)));
    assert.ok(held.items.filter((i) => i.triggerKey.startsWith("event_")).every((i) => i.state === "waiting"));
    const cancelled = planBooking(booking({ stage: "Cancelled" }), facts(et("2026-10-01", 9)));
    assert.ok(cancelled.items.every((i) => i.state === "stopped"));
  });
  it("missing email skips email with a reason while the text still goes", () => {
    const p = planBooking(booking({ contact: { phone: "+15555550100", email: null } }), facts(et("2026-10-13", 10, 5)));
    assert.equal(byTrigger(p.items, "event_week_reminder", "email").code, "no_email");
    assert.equal(byTrigger(p.items, "event_week_reminder", "sms").state, "due");
  });
  it("never sends the week reminder once the eve is due, or anything after the event starts", () => {
    const p = planBooking(booking(), facts(et("2026-10-19", 11)));
    assert.equal(byTrigger(p.items, "event_week_reminder").code, "superseded");
    assert.equal(byTrigger(p.items, "event_eve_reminder").state, "due");
    const after = planBooking(booking(), facts(et("2026-10-20", 11)));
    assert.equal(byTrigger(after.items, "event_eve_reminder").code, "past_event");
    assert.equal(byTrigger(after.items, "post_event_thanks").state, "scheduled");
  });
  it("only the thank-you goes for a past event, and only within 3 days", () => {
    assert.equal(byTrigger(planBooking(booking(), facts(et("2026-10-21", 10, 5))).items, "post_event_thanks").state, "due");
    assert.equal(byTrigger(planBooking(booking(), facts(et("2026-10-26", 10))).items, "post_event_thanks").state, "skipped");
  });
  it("a booking made late only gets milestones still in the future", () => {
    const late = booking({ createdAt: et("2026-10-16", 12), eventDate: "2026-10-20" });
    const p = planBooking(late, facts(et("2026-10-16", 13)));
    assert.equal(byTrigger(p.items, "event_week_reminder").code, "before_start");
    assert.equal(byTrigger(p.items, "event_eve_reminder").state, "scheduled");
  });
  it("rescheduling produces a fresh set (the event date is in the key)", () => {
    const a = planBooking(booking(), facts(et("2026-10-01", 9)));
    const b = planBooking(booking({ eventDate: "2026-11-03" }), facts(et("2026-10-01", 9)));
    assert.notEqual(byTrigger(a.items, "event_week_reminder").baseKey, byTrigger(b.items, "event_week_reminder").baseKey);
  });
  it("nudges an unsigned contract 48 hours after it was sent", () => {
    const sentAt = et("2026-10-01", 12);
    const b = booking({ stage: "Held", retainerPaid: false, contract: { sentAt, signed: false } });
    const early = planBooking(b, facts(et("2026-10-02", 12)));
    assert.equal(byTrigger(early.items, "contract_unsigned_nudge").state, "scheduled");
    const due = planBooking(b, facts(new Date(sentAt.getTime() + 48 * 3_600_000 + 60_000)));
    assert.equal(byTrigger(due.items, "contract_unsigned_nudge").state, "due");
    const signed = planBooking({ ...b, contract: { sentAt, signed: true } }, facts(et("2026-10-04", 12)));
    assert.equal(byTrigger(signed.items, "contract_unsigned_nudge").state, "stopped");
  });
  it("balance reminders start in the window, every 3 days, and stop when paid", () => {
    const p = planBooking(booking(), facts(et("2026-10-01", 9)));
    const days = p.items.filter((i) => i.triggerKey === "balance_due_reminder" && i.channel === "sms").map((i) => easternDay(i.dueAt));
    assert.deepEqual(days, ["2026-10-13", "2026-10-16", "2026-10-19"]);
    const paid = planBooking(booking({ balancePaid: true }), facts(et("2026-10-01", 9)));
    assert.ok(paid.items.filter((i) => i.triggerKey === "balance_due_reminder").every((i) => i.state === "stopped"));
    const auto = planBooking(booking({ balancePref: "Auto-charge" }), facts(et("2026-10-01", 9)));
    assert.ok(auto.items.filter((i) => i.triggerKey === "balance_due_reminder").every((i) => i.state === "stopped"));
  });
  it("respects the 3-day cooldown from the last balance reminder", () => {
    const p = planBooking(booking({ lastBalanceReminderAt: et("2026-10-13", 10, 5) }), facts(et("2026-10-16", 10, 5)));
    const oct16 = p.items.find((i) => i.triggerKey === "balance_due_reminder" && i.channel === "sms" && easternDay(i.dueAt) === "2026-10-16")!;
    assert.equal(oct16.state, "due");
    const soon = planBooking(booking({ lastBalanceReminderAt: et("2026-10-15", 10, 5) }), facts(et("2026-10-16", 10, 5)));
    assert.equal(soon.items.find((i) => i.triggerKey === "balance_due_reminder" && i.channel === "sms" && easternDay(i.dueAt) === "2026-10-16")!.state, "skipped");
  });
  it("pause shows as Paused by staff", () => {
    const p = planBooking(booking({ paused: true }), facts(et("2026-10-01", 9)));
    assert.ok(p.items.every((i) => i.state === "paused" || i.state === "stopped" || i.state === "waiting"));
    assert.equal(byTrigger(p.items, "event_week_reminder").reason, "Paused by staff");
  });
  it("DST: reminders stay at 10 AM local across the fall-back weekend", () => {
    const p = planBooking(booking({ eventDate: "2026-11-05" }), facts(et("2026-10-20", 9)));
    assert.equal(byTrigger(p.items, "event_week_reminder").dueAt.toISOString(), et("2026-10-29", 10).toISOString());
    assert.equal(byTrigger(p.items, "post_event_thanks").dueAt.toISOString(), "2026-11-06T15:00:00.000Z");
  });
});

const gig = (over: Partial<GigInput> = {}): GigInput => ({ gigId: "G1", crewMemberId: "C1", eventDate: "2026-11-20", acceptedAt: et("2026-10-01", 12), offerStatus: "Accepted", gigStatus: "Filled", paused: false, contact: { phone: "+15555550111", email: "c@example.com" }, ...over });

describe("crew journey", () => {
  it("plans 30, 15, 7, 3 at 10 AM and the eve at 6 PM, text only", () => {
    const p = planGig(gig(), facts(et("2026-10-02", 9)));
    assert.equal(p.items.length, 5);
    assert.ok(p.items.every((i) => i.channel === "sms"));
    assert.equal(byTrigger(p.items, "crew_reminder_30").dueAt.toISOString(), et("2026-10-21", 10).toISOString());
    assert.equal(byTrigger(p.items, "crew_reminder_eve").dueAt.toISOString(), et("2026-11-19", 18).toISOString());
  });
  it("accepted late gets only future milestones", () => {
    const p = planGig(gig({ acceptedAt: et("2026-11-10", 12) }), facts(et("2026-11-10", 12, 30)));
    assert.equal(byTrigger(p.items, "crew_reminder_30").code, "before_start");
    assert.equal(byTrigger(p.items, "crew_reminder_15").code, "before_start");
    assert.equal(byTrigger(p.items, "crew_reminder_7").state, "scheduled");
  });
  it("never sends '30 days out' late", () => {
    const p = planGig(gig(), facts(et("2026-11-15", 11)));
    assert.equal(byTrigger(p.items, "crew_reminder_30").code, "superseded");
    assert.equal(byTrigger(p.items, "crew_reminder_15").code, "superseded");
    assert.equal(byTrigger(p.items, "crew_reminder_7").state, "due");
    const later = planGig(gig(), facts(et("2026-11-17", 11)));
    assert.equal(byTrigger(later.items, "crew_reminder_7").code, "superseded");
    assert.equal(byTrigger(later.items, "crew_reminder_3").state, "due");
  });
  it("stops when the offer is no longer accepted or the gig is cancelled", () => {
    assert.equal(planGig(gig({ offerStatus: "Declined" }), facts(et("2026-10-22", 10))).items[0].state, "stopped");
    assert.equal(planGig(gig({ gigStatus: "Cancelled" }), facts(et("2026-10-22", 10))).items[0].state, "stopped");
  });
  it("blocks on the missing gig link and says why, in advance", () => {
    const blocked = { "crew_reminder_30:sms": "No value for {{gigLink}}" };
    const p = planGig(gig(), facts(et("2026-10-02", 9), { blocked }));
    const i = byTrigger(p.items, "crew_reminder_30");
    assert.equal(i.state, "blocked");
    assert.match(i.reason!, /gigLink/);
  });
  it("Sundays are fine for crew reminders", () => {
    // 2026-11-01 is a Sunday: 3 days before Nov 4 is Nov 1.
    const p = planGig(gig({ eventDate: "2026-11-04", acceptedAt: et("2026-10-01", 12) }), facts(et("2026-11-01", 10, 5)));
    assert.equal(byTrigger(p.items, "crew_reminder_3").state, "due");
  });
});

describe("retry cap and terminal states", () => {
  it("a failed send with attempts left is due again; at 3 attempts it is failed_final", () => {
    const now = et("2026-10-08", 12);
    const k = "lead_nurture_day3:L1:sms";
    const retry = planLead(lead(), facts(now, { logs: { [k]: { status: "failed", attempts: 2, sentAt: null, error: "boom" } } }));
    assert.equal(byTrigger(retry.items, "lead_nurture_day3").state, "due");
    const dead = planLead(lead(), facts(now, { logs: { [k]: { status: "failed", attempts: 3, sentAt: null, error: "boom" } } }));
    assert.equal(byTrigger(dead.items, "lead_nurture_day3").state, "failed_final");
    const final = planLead(lead(), facts(now, { logs: { [k]: { status: "failed_final", attempts: 3, sentAt: null, error: "boom" } } }));
    assert.equal(byTrigger(final.items, "lead_nurture_day3").state, "failed_final");
  });
});

describe("running twice", () => {
  it("a sent item is not due again", () => {
    const now = et("2026-10-08", 10, 5);
    const logs = { "lead_nurture_day3:L1:sms": { status: "sent", attempts: 1, sentAt: now, error: null } };
    const p = planLead(lead(), facts(new Date(now.getTime() + 3_600_000), { logs }));
    assert.equal(p.items.filter((i) => i.state === "due").length, 0);
  });
});
