import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atEastern, easternDay, skipSunday } from "../automation/time.js";
import { planBooking, planDigest, planGig, planLead, type BookingInput, type Facts, type GigInput, type LeadInput, type LogFact, type PlanItem } from "../automation/planner.js";
import type { Channel } from "../triggers.js";

const START = new Date("2026-01-01T00:00:00Z");

function facts(now: Date, opts: { logs?: Record<string, LogFact>; off?: string[]; optedOut?: string[]; blocked?: Record<string, string> } = {}): Facts {
  return {
    now,
    automationStartedAt: START,
    log: (k, c) => opts.logs?.[`${k}:${c}`],
    // Text on for everything; email only where the registry defaults it on.
    channelOn: (t, c) => !opts.off?.includes(`${t}:${c}`) && (c === "sms" || ["wedding_details_reminder_60", "wedding_details_reminder_35", "staff_daily_digest", "contract_unsigned_nudge", "balance_due_reminder", "event_week_reminder", "event_eve_reminder", "post_event_thanks"].includes(t)),
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

describe("storefront holds", () => {
  it("sends nothing scheduled to a storefront booking that is Held and unsigned", () => {
    const p = planBooking(booking({ stage: "Held", retainerPaid: true, storefrontHeldUnsigned: true, contract: { sentAt: et("2026-10-01", 12), signed: false } }), facts(et("2026-10-13", 10, 5)));
    assert.ok(p.items.length > 0);
    assert.ok(p.items.every((i) => i.state === "stopped" || i.state === "sent"), "balance, event reminders and the contract nudge are all held back");
    assert.match(p.items[0].reason ?? "", /Storefront hold/);
  });
  it("resumes once it moves past Held or is signed", () => {
    const p = planBooking(booking({ storefrontHeldUnsigned: false }), facts(et("2026-10-13", 10, 5)));
    assert.equal(byTrigger(p.items, "event_week_reminder").state, "due");
  });
  it("the balance reminder respects it even when the retainer was ticked", () => {
    const p = planBooking(booking({ stage: "Held", retainerPaid: true, storefrontHeldUnsigned: true }), facts(et("2026-10-16", 10, 5)));
    assert.ok(p.items.filter((i) => i.triggerKey === "balance_due_reminder").every((i) => i.state === "stopped"));
  });
});

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

describe("staff daily digest", () => {
  const d = { day: "2026-11-11", enabled: true, email: "digest@example.test", count: 2 };
  it("plans nothing before 7 AM Eastern", () => {
    assert.deepEqual(planDigest(d, facts(et("2026-11-11", 6, 59))).items, []);
  });
  it("is due at 7 AM, email only, keyed by the day", () => {
    const { items } = planDigest(d, facts(et("2026-11-11", 7)));
    assert.deepEqual(items.map((i) => [i.channel, i.state, i.baseKey]), [["email", "due", "staff_daily_digest:2026-11-11"]]);
    assert.equal(items[0].dueAt.toISOString(), et("2026-11-11", 7).toISOString());
  });
  it("goes on a late pass, but only once", () => {
    assert.equal(planDigest(d, facts(et("2026-11-11", 15))).items[0].state, "due");
    const logs = { "staff_daily_digest:2026-11-11:email": { status: "sent", attempts: 1, sentAt: et("2026-11-11", 7, 5), error: null } };
    assert.equal(planDigest(d, facts(et("2026-11-11", 8), { logs })).items[0].state, "sent");
  });
  it("sends nothing when there is nothing unread or it is switched off", () => {
    assert.deepEqual(planDigest({ ...d, count: 0 }, facts(et("2026-11-11", 8))).items, []);
    const off = planDigest({ ...d, enabled: false }, facts(et("2026-11-11", 8)));
    assert.equal(off.enrolled, false);
    assert.deepEqual(off.items, []);
  });
  it("stops if staff switch the digest email off in Templates", () => {
    assert.deepEqual(planDigest(d, facts(et("2026-11-11", 8), { off: ["staff_daily_digest:email"] })).items, []);
  });
});

describe("wedding details reminders", () => {
  const event = "2026-12-20";
  const b = (wedding: BookingInput["wedding"], over: Partial<BookingInput> = {}) => booking({ id: "B9", eventDate: event, createdAt: et("2026-08-01", 12), wedding, ...over });
  const r60 = (p: { items: PlanItem[] }) => p.items.find((i) => i.triggerKey === "wedding_details_reminder_60");
  const r35 = (p: { items: PlanItem[] }) => p.items.find((i) => i.triggerKey === "wedding_details_reminder_35");
  it("are email only, due 60 and 35 days out at 10 AM Eastern, keyed by the date", () => {
    const p = planBooking(b({ status: "not_started", hasAccount: true }), facts(et("2026-09-01", 12)));
    const mine = p.items.filter((i) => i.seriesId === "wedding_details");
    assert.deepEqual(mine.map((i) => i.channel), ["email", "email"]);
    assert.equal(r60(p)?.dueAt.toISOString(), et("2026-10-21", 10).toISOString());
    assert.equal(r35(p)?.dueAt.toISOString(), et("2026-11-15", 10).toISOString());
    assert.equal(r60(p)?.baseKey, "wedding_details_reminder_60:B9:2026-12-20");
    assert.equal(r60(p)?.state, "scheduled");
  });
  it("skip the 60 day reminder once started, and still send at 35", () => {
    const p = planBooking(b({ status: "in_progress", hasAccount: true }), facts(et("2026-11-15", 11)));
    assert.equal(r60(p)?.state, "skipped");
    assert.equal(r35(p)?.state, "due");
  });
  it("stop when submitted", () => {
    const p = planBooking(b({ status: "submitted", hasAccount: true }), facts(et("2026-11-15", 11)));
    assert.equal(r35(p)?.state, "stopped");
    assert.equal(r35(p)?.reason, "Stopped: details submitted");
  });
  it("send only once", () => {
    const logs = { "wedding_details_reminder_60:B9:2026-12-20:email": { status: "sent", attempts: 1, sentAt: et("2026-10-21", 10), error: null } };
    assert.equal(r60(planBooking(b({ status: "not_started", hasAccount: true }), facts(et("2026-10-21", 12), { logs })))?.state, "sent");
  });
  it("wait when the customer has no account to open the form with", () => {
    const p = planBooking(b({ status: "not_started", hasAccount: false }), facts(et("2026-10-21", 12)));
    assert.equal(r60(p)?.state, "waiting");
  });
  it("are not planned for a booking that is not a wedding, or a cancelled one", () => {
    assert.equal(r60(planBooking(b(null), facts(et("2026-10-21", 12)))), undefined);
    assert.equal(r60(planBooking(b({ status: "not_started", hasAccount: true }, { stage: "Cancelled" }), facts(et("2026-10-21", 12))))?.state, "stopped");
  });
  it("respect staff switching the email off", () => {
    assert.equal(r60(planBooking(b({ status: "not_started", hasAccount: true }), facts(et("2026-10-21", 12), { off: ["wedding_details_reminder_60:email"] }))), undefined);
  });
});

// Block F1: retainer reminders, counted from the first ask.
describe("retainer reminders", () => {
  // Asked Monday Oct 5 at noon; the event is Dec 20.
  const asked = et("2026-10-05", 12);
  const mine = (p: { items: PlanItem[] }) => p.items.filter((i) => i.seriesId === "retainer" && i.channel === "sms");
  const at = (now: Date, over: Partial<BookingInput> = {}, retainer: Partial<NonNullable<BookingInput["retainer"]>> = {}, logs: Record<string, LogFact> = {}) =>
    mine(planBooking(booking({ stage: "Held", retainerPaid: false, eventDate: "2026-12-20", createdAt: et("2026-10-05", 11), retainer: { requestedAt: asked, days: [1, 3, 7], owed: true, waitingOnSignature: false, ...retainer }, ...over }), facts(now, { logs })));

  it("plans 1, 3 and 7 days after the ask at 10 AM Eastern, keyed by position", () => {
    const items = at(et("2026-10-05", 13));
    assert.deepEqual(items.map((i) => i.dueAt.toISOString()), [et("2026-10-06", 10), et("2026-10-08", 10), et("2026-10-12", 10)].map((d) => d.toISOString()));
    assert.deepEqual(items.map((i) => i.baseKey), ["retainer_reminder:B1:1", "retainer_reminder:B1:2", "retainer_reminder:B1:3"]);
    assert.ok(items.every((i) => i.triggerKey === "retainer_reminder" && i.state === "scheduled"));
  });
  it("each one comes due on its day and not before", () => {
    assert.deepEqual(at(et("2026-10-06", 9, 59)).map((i) => i.state), ["scheduled", "scheduled", "scheduled"]);
    assert.deepEqual(at(et("2026-10-06", 10, 5)).map((i) => i.state), ["due", "scheduled", "scheduled"]);
  });
  it("stops on payment, on cancellation, and when nothing is owed", () => {
    assert.ok(at(et("2026-10-06", 10, 5), { retainerPaid: true }).every((i) => i.state === "stopped" && i.reason === "Stopped: retainer paid"));
    assert.ok(at(et("2026-10-06", 10, 5), { stage: "Cancelled" }).every((i) => i.state === "stopped" && i.reason === "Booking cancelled"));
    assert.ok(at(et("2026-10-06", 10, 5), {}, { owed: false }).every((i) => i.state === "stopped"));
  });
  it("a contract booking that is not signed waits on the signature", () => {
    assert.ok(at(et("2026-10-06", 10, 5), { stage: "Contract Sent" }, { waitingOnSignature: true }).every((i) => i.state === "waiting" && i.reason === "Waits for the contract to be signed."));
  });
  it("a day set to 0 is off, and nothing is planned before the retainer was asked for", () => {
    assert.equal(at(et("2026-10-06", 10, 5), {}, { days: [1, 0, 7] }).length, 2);
    assert.equal(at(et("2026-10-06", 10, 5), {}, { requestedAt: null }).length, 0);
  });
  it("the storefront hold does not stop them, and a paid storefront booking that is Confirmed has no hold", () => {
    assert.deepEqual(at(et("2026-10-06", 10, 5), { storefrontHeldUnsigned: true }).map((i) => i.state), ["due", "scheduled", "scheduled"]);
    const confirmed = planBooking(booking({ stage: "Held", retainerPaid: true, storefrontHeldUnsigned: false, eventDate: "2026-12-20" }), facts(et("2026-10-06", 10, 5)));
    assert.ok(confirmed.items.filter((i) => i.seriesId === "event").every((i) => i.state !== "stopped"));
  });
});
