// Block F3b. First the rules with no database (why a booking needs action,
// the one status in words, the views, who accepted the policy, a request as a
// lead's row, follow ups stopping), then over HTTP on a throwaway database:
// policy acceptance from the pay link, what the pay link and the customer's
// bookings carry, a storefront request making its lead, and the automatic
// follow ups stopping once staff take a lead over. Twilio, the email webhook
// and Stripe are stubbed.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.STOREFRONT_URL = "https://store.test";
process.env.PUBLIC_API_URL = "https://api.test";
process.env.EMAIL_WEBHOOK_URL = "http://stub.invalid/hook";
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "https://store.test";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.GOOGLE_MAPS_SERVER_KEY;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { runAsActor } from "../actor.js";
import { loadPlans } from "../automation/loaders.js";
import { planLead, type Facts, type LeadInput } from "../automation/planner.js";
import { addDays } from "../automation/time.js";
import { bookingItemLines, itemsBrief } from "../bookingItems.js";
import { BOOKING_VIEWS, STATUS_WORDS, buildBookingsList, filterRows, needsActionFor, nextBookingAction, statusWord, viewsOf, type BookingFacts } from "../bookingsList.js";
import { decideCancellation } from "../cancellations.js";
import { prisma } from "../db.js";
import { buildInbox, type InboxLead, type InboxRequest } from "../inbox.js";
import { policyLine, policyStateOf, type PolicyFacts, type PolicyState } from "../policyAccept.js";
import { customerWriteGuard } from "../security.js";
import { buildToday } from "../today.js";
import bookingsListRouter from "../routes/bookingsList.js";
import customerRouter from "../routes/customer.js";
import designRequestsRouter from "../routes/designRequests.js";
import directBookingsRouter, { staffBookingRouter } from "../routes/directBookings.js";
import { inboxRouter, leadActionsRouter, todayRouter } from "../routes/inbox.js";
import leadsRouter from "../routes/leads.js";
import { payApiRouter } from "../routes/pay.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("f3bBookings.test.ts runs only against a throwaway database (name containing zz_scratch)");

// ---- the rules, with no database ---------------------------------------------------
const TODAY = "2026-11-16";
const at = (day: string, hour = 12) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
const accepted: PolicyState = { needed: true, by: "customer", via: "checkout", at: "2026-11-10T15:00:00.000Z", version: 3 };
const notAccepted: PolicyState = { needed: true, by: "nobody", via: null, at: null, version: null };
const onContract: PolicyState = { needed: false, by: "nobody", via: null, at: null, version: null };
// A small rental, paid up and going ahead: nothing to do.
const facts = (over: Partial<BookingFacts> = {}): BookingFacts => ({
  id: "B1",
  leadId: "L1",
  customerName: "Sarah Miller",
  email: "sarah@example.com",
  phone: "(860) 555-0142",
  eventDate: "2026-12-20",
  eventTime: "2 PM",
  occasion: "Sweet 16",
  stage: "Held",
  rush: false,
  totalCents: 22500,
  paidCents: 4500,
  needsSignature: false,
  contractSentAt: null,
  retainerPaid: true,
  retainerOwedCents: null,
  balanceOwedCents: 18000,
  balanceDueDate: "2026-12-06",
  payLinkSentAt: null,
  cancellationRequested: false,
  policy: accepted,
  weddingDetailsMissing: false,
  crewNeeded: 0,
  crewUnassigned: 0,
  items: [{ name: "Portable Bar", quantity: 1 }],
  packageName: null,
  ...over,
});
const codes = (f: BookingFacts) => needsActionFor(f, TODAY).map((n) => n.code);

describe("why a booking needs action", () => {
  test("a paid up booking with its policy accepted needs nothing", () => {
    assert.deepEqual(codes(facts()), []);
    assert.deepEqual(viewsOf(facts(), TODAY), ["upcoming"]);
    assert.equal(nextBookingAction(facts({ balanceOwedCents: null }), TODAY).code, "none");
  });

  test("each of the seven reasons, and the row says which", () => {
    assert.deepEqual(codes(facts({ needsSignature: true, policy: onContract, retainerPaid: false, retainerOwedCents: 50000 })), ["unsigned"], "the retainer waits for the signature, so it is not also listed");
    assert.equal(needsActionFor(facts({ needsSignature: true, policy: onContract, contractSentAt: "2026-11-15T15:00:00.000Z" }), TODAY)[0].label, "Contract unsigned");
    assert.equal(needsActionFor(facts({ needsSignature: true, policy: onContract }), TODAY)[0].label, "Contract not sent");
    assert.deepEqual(codes(facts({ policy: notAccepted })), ["policy"]);
    assert.deepEqual(codes(facts({ retainerPaid: false, retainerOwedCents: 4500 })), ["retainer"]);
    assert.equal(needsActionFor(facts({ retainerPaid: false, retainerOwedCents: 4500 }), TODAY)[0].label, "Retainer unpaid, $45.00");
    assert.deepEqual(codes(facts({ balanceDueDate: "2026-11-15" })), ["balance-overdue"]);
    assert.deepEqual(codes(facts({ balanceDueDate: TODAY })), [], "due today is not overdue yet");
    assert.deepEqual(codes(facts({ cancellationRequested: true })), ["cancellation"]);
    assert.deepEqual(codes(facts({ weddingDetailsMissing: true, eventDate: addDays(TODAY, 45) })), ["wedding-details"]);
    assert.deepEqual(codes(facts({ weddingDetailsMissing: true, eventDate: addDays(TODAY, 46) })), [], "outside 45 days it can wait");
    assert.deepEqual(codes(facts({ crewNeeded: 2, crewUnassigned: 2, eventDate: addDays(TODAY, 7), balanceOwedCents: null })), ["crew"]);
    assert.deepEqual(codes(facts({ crewNeeded: 2, crewUnassigned: 2, eventDate: addDays(TODAY, 8), balanceOwedCents: null })), [], "outside 7 days it can wait");
    assert.deepEqual(codes(facts({ crewNeeded: 2, crewUnassigned: 0, eventDate: addDays(TODAY, 3), balanceOwedCents: null })), [], "crew is assigned");
    assert.equal(needsActionFor(facts({ crewNeeded: 2, crewUnassigned: 1, eventDate: addDays(TODAY, 3), balanceOwedCents: null }), TODAY)[0].label, "1 of 2 crew spots open");
  });

  test("several reasons are listed most pressing first, and a cancelled or finished booking needs nothing", () => {
    const messy = facts({ cancellationRequested: true, policy: notAccepted, retainerPaid: false, retainerOwedCents: 4500, weddingDetailsMissing: true, eventDate: addDays(TODAY, 5), crewNeeded: 1, crewUnassigned: 1, balanceOwedCents: null });
    assert.deepEqual(codes(messy), ["cancellation", "policy", "retainer", "wedding-details", "crew"]);
    assert.deepEqual(codes({ ...messy, stage: "Cancelled" }), []);
    assert.deepEqual(codes({ ...messy, stage: "Released" }), []);
    assert.deepEqual(codes({ ...messy, stage: "Completed" }), []);
    assert.deepEqual(viewsOf(messy, TODAY), ["needs-action", "upcoming"]);
    assert.deepEqual(viewsOf({ ...messy, stage: "Cancelled" }, TODAY), ["cancelled"]);
    assert.deepEqual(viewsOf(facts({ eventDate: "2026-11-01", balanceOwedCents: null }), TODAY), ["past"]);
    assert.deepEqual(viewsOf(facts({ eventDate: "2026-11-01", balanceDueDate: "2026-10-18" }), TODAY), ["needs-action", "past"], "an unpaid balance after the event still needs action");
  });

  test("the main button follows the first reason", () => {
    assert.equal(nextBookingAction(facts({ cancellationRequested: true }), TODAY).code, "decide-cancellation");
    assert.equal(nextBookingAction(facts({ needsSignature: true, policy: onContract }), TODAY).label, "Send contract link");
    assert.equal(nextBookingAction(facts({ policy: notAccepted }), TODAY).label, "Send pay link");
    assert.equal(nextBookingAction(facts({ retainerPaid: false, retainerOwedCents: 4500 }), TODAY).label, "Send pay link");
    assert.equal(nextBookingAction(facts({ weddingDetailsMissing: true, eventDate: addDays(TODAY, 10), balanceOwedCents: null }), TODAY).code, "wedding-details");
    assert.equal(nextBookingAction(facts({ crewNeeded: 1, crewUnassigned: 1, eventDate: addDays(TODAY, 2), balanceOwedCents: null }), TODAY).code, "assign-crew");
  });
});

describe("the one status in words", () => {
  test("there are exactly seven, and each has its case", () => {
    assert.deepEqual([...STATUS_WORDS], ["Awaiting contract", "Awaiting retainer", "Confirmed", "Balance due", "Cancellation requested", "Cancelled", "Done"]);
    assert.equal(statusWord(facts({ needsSignature: true, policy: onContract, retainerPaid: false, retainerOwedCents: 50000 }), TODAY), "Awaiting contract");
    assert.equal(statusWord(facts({ retainerPaid: false, retainerOwedCents: 4500 }), TODAY), "Awaiting retainer");
    assert.equal(statusWord(facts({ retainerPaid: false, retainerOwedCents: null, totalCents: null, balanceOwedCents: null, balanceDueDate: null }), TODAY), "Awaiting retainer", "no price yet and nothing ticked");
    assert.equal(statusWord(facts(), TODAY), "Confirmed", "the balance is due in 20 days: not yet");
    assert.equal(statusWord(facts({ balanceDueDate: addDays(TODAY, 14) }), TODAY), "Balance due");
    assert.equal(statusWord(facts({ balanceDueDate: "2026-11-10" }), TODAY), "Balance due");
    assert.equal(statusWord(facts({ balanceOwedCents: null }), TODAY), "Confirmed");
    assert.equal(statusWord(facts({ cancellationRequested: true }), TODAY), "Cancellation requested");
    assert.equal(statusWord(facts({ stage: "Cancelled" }), TODAY), "Cancelled");
    assert.equal(statusWord(facts({ stage: "Released", cancellationRequested: true }), TODAY), "Cancelled");
    assert.equal(statusWord(facts({ stage: "Completed" }), TODAY), "Done");
    assert.equal(statusWord(facts({ eventDate: "2026-11-01", balanceOwedCents: null }), TODAY), "Done");
    assert.equal(statusWord(facts({ eventDate: "2026-11-01" }), TODAY), "Balance due", "the event happened and money is still owed");
  });

  test("no row says No agreement on file or Balance: Manual", () => {
    const { rows } = buildBookingsList([facts(), facts({ id: "B2", policy: notAccepted }), facts({ id: "B3", stage: "Cancelled" })], TODAY);
    assert.ok(!/No agreement on file|Balance: /.test(JSON.stringify(rows)));
    for (const r of rows) assert.ok((STATUS_WORDS as readonly string[]).includes(r.status));
  });
});

describe("the Bookings list", () => {
  const list = [
    facts({ id: "ok" }),
    facts({ id: "policy", policy: notAccepted, customerName: "Dana Lee", email: "dana@example.com", phone: "8605550111", eventDate: "2026-11-30" }),
    facts({ id: "past", eventDate: "2026-10-01", balanceOwedCents: null, stage: "Completed" }),
    facts({ id: "gone", stage: "Cancelled" }),
  ];
  test("the views are Needs action, Upcoming, Past, Cancelled, and each is counted", () => {
    const { rows, counts } = buildBookingsList(list, TODAY);
    assert.deepEqual(BOOKING_VIEWS.map((v) => v.label), ["Needs action", "Upcoming", "Past", "Cancelled"]);
    assert.deepEqual(counts, { "needs-action": 1, upcoming: 2, past: 1, cancelled: 1 });
    assert.deepEqual(rows.map((r) => r.id), ["past", "policy", "ok", "gone"], "soonest event first");
    assert.equal(rows.find((r) => r.id === "policy")!.needs[0].label, "Policy not accepted");
  });
  test("search by name, email or phone, and filter by date range and status", () => {
    const { rows } = buildBookingsList(list, TODAY);
    assert.deepEqual(filterRows(rows, { q: "dana" }).map((r) => r.id), ["policy"]);
    assert.deepEqual(filterRows(rows, { q: "DANA@EXAMPLE" }).map((r) => r.id), ["policy"]);
    assert.deepEqual(filterRows(rows, { q: "(860) 555-0111" }).map((r) => r.id), ["policy"]);
    assert.deepEqual(filterRows(rows, { from: "2026-11-01", to: "2026-11-30" }).map((r) => r.id), ["policy"]);
    assert.deepEqual(filterRows(rows, { status: "Cancelled" }).map((r) => r.id), ["gone"]);
    assert.deepEqual(filterRows(rows, { status: "Done" }).map((r) => r.id), ["past"]);
  });
  test("items in brief", () => {
    const lines = bookingItemLines([{ unit: { item: { name: "Chair" } } }, { unit: { item: { name: "Chair" } } }, { unit: { item: { name: "Tent" } } }], [{ itemName: "DJ", skill: "DJ", status: "Needs Crew" }, { itemName: "DJ", skill: "Roadie", status: "Filled" }, { itemName: "Bartender", skill: "Bar", status: "Cancelled" }]);
    assert.deepEqual(lines, [{ name: "Chair", quantity: 2 }, { name: "Tent", quantity: 1 }, { name: "DJ", quantity: 1 }]);
    assert.equal(itemsBrief(lines, null), "Chair x 2, Tent and 1 more");
    assert.equal(itemsBrief(lines, "Sweet 16 Package"), "Sweet 16 Package");
    assert.equal(itemsBrief([], null), "No items");
  });
});

describe("who accepted the policy", () => {
  const p = (over: Partial<PolicyFacts> = {}): PolicyFacts => ({ tier: 1, origin: "staff", policyAcceptedAt: null, policyAcceptedVersion: null, agreement: null, lead: null, designRequest: null, ...over });
  const tick = { checkboxChecked: true, agreedAt: at("2026-11-10"), policyVersion: { version: 3 } };
  test("the pay link, the store checkout, staff by phone, or nobody", () => {
    assert.deepEqual([policyStateOf(p()).by, policyStateOf(p()).needed], ["nobody", true]);
    assert.deepEqual([policyStateOf(p({ agreement: tick })).by, policyStateOf(p({ agreement: tick })).via], ["staff", "phone"], "a staff tick is a record, not the customer's acceptance");
    assert.deepEqual([policyStateOf(p({ origin: "storefront", agreement: tick })).by, policyStateOf(p({ origin: "storefront", agreement: tick })).via], ["customer", "checkout"]);
    assert.equal(policyStateOf(p({ origin: null, lead: { source: "storefront" }, agreement: tick })).by, "customer", "an old booking with no origin falls back to its lead");
    assert.equal(policyStateOf(p({ designRequest: { id: "R1" }, agreement: tick })).by, "customer", "a converted request carries the tick the customer gave in the store");
    assert.equal(policyStateOf(p({ origin: "storefront", agreement: { ...tick, checkboxChecked: false } })).by, "nobody");
    const paid = policyStateOf(p({ policyAcceptedAt: at("2026-11-15"), policyAcceptedVersion: 4, agreement: tick }));
    assert.deepEqual([paid.by, paid.via, paid.version], ["customer", "pay-link", 4], "the pay link wins over a staff tick");
    assert.equal(policyStateOf(p({ tier: 2 })).needed, false, "a contract booking has no policy to accept");
  });
  test("the line staff read", () => {
    assert.match(policyLine(policyStateOf(p({ policyAcceptedAt: at("2026-11-15"), policyAcceptedVersion: 4 }))), /^Policy accepted by customer on November 15, 2026, on the pay page \(version 4\)\.$/);
    assert.match(policyLine(policyStateOf(p({ agreement: tick }))), /^Staff confirmed by phone on November 10, 2026/);
    assert.match(policyLine(policyStateOf(p())), /^Policy not accepted yet/);
  });
});

describe("a storefront request is its lead's row", () => {
  const COLUMNS = ["New", "Contacted", "Booked", "Lost"];
  const request = (over: Partial<InboxRequest> = {}): InboxRequest => ({ id: "R1", status: "Open", customerName: "Dana Lee", phone: "8605550111", email: "dana@example.com", occasion: "Reception only", eventDate: at("2026-12-26", 0), total: 5400, cart: { items: [{ name: "Grand Tent", quantity: 1 }], addons: [], package: null }, createdAt: at("2026-11-15"), dismissReason: null, leadId: "L1", ...over });
  const lead = (over: Partial<InboxLead> = {}): InboxLead => ({ id: "L1", status: "New", source: "storefront", customerName: "Dana Lee", contact: "8605550111 · dana@example.com", occasion: "Reception only", dateOfInterest: at("2026-12-26", 0), notes: null, theme: null, itemsReturned: null, tags: [], createdAt: at("2026-11-15"), updatedAt: at("2026-11-15"), firstContactedAt: null, lastContactedAt: null, followUpOn: null, followUpNote: null, lostReason: null, bookings: [], designRequests: [request()], ...over });
  test("one row, source Storefront, in All and Storefront requests, opening the request", () => {
    const { rows, counts } = buildInbox([lead()], [request()], COLUMNS, TODAY);
    assert.equal(rows.length, 1, "the request is not a second row");
    const r = rows[0];
    assert.deepEqual([r.kind, r.id, r.requestId, r.source, r.stage, r.wants, r.eventDate, r.nextAction.label], ["lead", "L1", "R1", "Storefront", "Storefront request", "Grand Tent", "2026-12-26", "Review it, then convert or dismiss"]);
    assert.deepEqual(counts, { all: 1, new: 0, requests: 1, cancellations: 0, "follow-up": 0, booked: 0, lost: 0 });
    const today = buildToday(rows, [], TODAY);
    const close = today[0];
    assert.equal(close.count, 1, "on Today once, under Storefront requests, not also under New leads");
    assert.deepEqual(close.groups.find((g) => g.key === "requests")!.items.map((i) => [i.open.kind, i.open.id, i.button]), [["request", "R1", "Review"]]);
  });
  test("a request from before this block, with no lead, is still its own row", () => {
    const { rows } = buildInbox([], [request({ leadId: null })], COLUMNS, TODAY);
    assert.deepEqual(rows.map((r) => [r.key, r.kind, r.requestId]), [["request:R1", "request", "R1"]]);
  });
  test("dismissed, the lead is the row and reads as lost", () => {
    const gone = request({ status: "Dismissed", dismissReason: "Out of our area" });
    const { rows, counts } = buildInbox([lead({ status: "Lost", lostReason: "Other", designRequests: [gone] })], [gone], COLUMNS, TODAY);
    assert.deepEqual(rows.map((r) => [r.key, r.bucket, r.requestId]), [["lead:L1", "lost", null]]);
    assert.equal(counts.lost, 1);
  });
});

describe("automatic follow ups stop when staff take the lead over", () => {
  const now = at("2026-10-05", 15);
  const f: Facts = { now, automationStartedAt: at("2026-01-01"), log: () => undefined, channelOn: () => true, optedOut: () => false, blockedReason: () => null };
  const base: LeadInput = { id: "L1", source: "phone", createdAt: at("2026-10-01"), stage: "New", hasBooking: false, paused: false, dateOfInterest: null, contact: { phone: "+18605550142", email: "sarah@example.com" } };
  const reasons = (lead: LeadInput) => planLead(lead, f).items.map((i) => [i.state, i.reason]);
  test("a logged contact or a follow up date stops both messages, on both channels", () => {
    assert.ok(planLead(base, f).items.length > 0);
    assert.ok(planLead(base, f).items.every((i) => i.state !== "stopped"), JSON.stringify(reasons(base)));
    const contacted = planLead({ ...base, staffContacted: true }, f).items;
    assert.ok(contacted.every((i) => i.state === "stopped" && i.reason === "Stopped: staff logged a contact"), JSON.stringify(reasons({ ...base, staffContacted: true })));
    const dated = planLead({ ...base, followUpSet: true }, f).items;
    assert.ok(dated.every((i) => i.state === "stopped" && i.reason === "Stopped: staff set a follow up date"));
  });
});

// ---- over HTTP, on a throwaway database -------------------------------------------
const ZZ = "ZZTEST";
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const made = { items: [] as string[], customers: [] as string[], policies: [] as string[], statuses: [] as string[] };
let settingsBefore: Record<string, unknown> | null = null;
let bar = "";
let hall = "";
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
  if (url.startsWith("http://stub.invalid/")) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  return realFetch(input, init);
}) as typeof fetch;

type Res = { status: number; json: Record<string, unknown>; cookie: string | null };
let ipCount = 0;
async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res> {
  ipCount += 1;
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://store.test", "X-Forwarded-For": `10.8.${Math.floor(ipCount / 200)}.${ipCount % 200}` };
  if (init.cookie) headers.Cookie = init.cookie;
  const r = await realFetch(`${base}${path}`, { ...init, headers });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown>, cookie: set ? set.split(";")[0] : null };
}
const post = (path: string, body: unknown, cookie?: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const patch = (path: string, body: unknown) => call(path, { method: "PATCH", body: JSON.stringify(body) });
const get = (path: string, cookie?: string) => call(path, { cookie });
// Days are counted from today in Eastern time, as the app counts them.
const day = (n: number) => addDays(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()), n);
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
let n = 0;
type Row = { key: string; kind: string; id: string; tabs: string[]; bucket: string; source: string; stage: string; requestId: string | null; bookingId: string | null; nextAction: { code: string; label: string } };
const inbox = async () => (await get("/api/inbox")).json as unknown as { tabs: { key: string; count: number }[]; rows: Row[] };
async function signup(label: string, phone: string) {
  n += 1;
  const r = await post("/api/customer/signup", { name: `${ZZ} F3b ${label} ${n}`, phone, email: `zz-f3b-${label.toLowerCase()}-${n}@example.test`, password: "a-long-enough-password" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const id = (r.json.customer as { id: string }).id;
  made.customers.push(id);
  return { id, cookie: r.cookie as string, name: `${ZZ} F3b ${label} ${n}`, email: `zz-f3b-${label.toLowerCase()}-${n}@example.test` };
}

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  settingsBefore = { reviewAmountKids: a.reviewAmountKids, reviewAmountAdult: a.reviewAmountAdult, reviewAmountWedding: a.reviewAmountWedding, reviewAmountCorporate: a.reviewAmountCorporate, reviewAmountDefault: a.reviewAmountDefault, contractRequiredOver: a.contractRequiredOver, contractRequiredForCrewed: a.contractRequiredForCrewed, requireAgreementCheckbox: a.requireAgreementCheckbox, requireCustomerAccount: a.requireCustomerAccount, directBookingDailyCap: a.directBookingDailyCap, requireBotCheck: a.requireBotCheck, depositPercentage: a.depositPercentage, tier1Collect: a.tier1Collect, useGoContract: a.useGoContract, balanceDueDays: a.balanceDueDays, automationStartedAt: a.automationStartedAt };
  await prisma.account.update({ where: { id: accountId }, data: { reviewAmountKids: 10000, reviewAmountAdult: 10000, reviewAmountWedding: 5000, reviewAmountCorporate: 5000, reviewAmountDefault: 10000, contractRequiredOver: 1000, contractRequiredForCrewed: true, requireAgreementCheckbox: false, requireCustomerAccount: false, directBookingDailyCap: 1000, requireBotCheck: false, depositPercentage: 20, tier1Collect: "retainer", useGoContract: false, balanceDueDays: 14, automationStartedAt: new Date(Date.now() - 86_400_000) } });
  await prisma.customer.deleteMany({ where: { accountId, email: { startsWith: "zz-f3b-" } } });
  for (const [i, name] of ["New", "Contacted", "Booked", "Lost"].entries()) {
    if ((await prisma.leadStatus.count({ where: { accountId, name } })) === 0) made.statuses.push((await prisma.leadStatus.create({ data: { accountId, name, position: i } })).id);
  }
  const policy = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  if (!policy || policy.text.trim() === "") made.policies.push((await prisma.policyVersion.create({ data: { accountId, version: (policy?.version ?? 0) + 1, text: `${ZZ} rental policy: the retainer is {{depositPercentage}}% and non-refundable.` } })).id);
  const mk = async (name: string, category: string, price: number) => {
    const item = await prisma.item.create({ data: { accountId, name: `${ZZ} F3b ${name}`, category, price, units: { create: Array.from({ length: 20 }, (_, i) => ({ label: String(i + 1) })) } } });
    made.items.push(item.id);
    return item.id;
  };
  bar = await mk("Portable Bar", "Bar and Cigar", 225);
  hall = await mk("Grand Setup", "Decor", 2500);

  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/customer", customerWriteGuard);
  app.use("/api/bookings/direct", customerWriteGuard);
  app.use(express.json({ limit: "64kb" }));
  const staff = (_req: express.Request, _res: express.Response, next: express.NextFunction) => runAsActor({ id: "zz-owner", name: "ZZ Owner", role: "Owner" }, () => next());
  app.use("/api/customer", customerRouter);
  app.use("/api/pay", payApiRouter);
  app.use("/api/bookings/direct", directBookingsRouter);
  app.use("/api/bookings/staff", staff, staffBookingRouter);
  app.use("/api/bookings", staff, bookingsListRouter);
  app.use("/api/design-requests", staff, designRequestsRouter);
  app.use("/api/inbox", staff, inboxRouter);
  app.use("/api/today", staff, todayRouter);
  app.use("/api/leads", staff, leadActionsRouter);
  app.use("/api/leads", staff, leadsRouter);
  app.use(((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.log("[test] route threw:", err instanceof Error ? err.stack : String(err));
    res.status(500).json({ error: "test: route threw" });
  }) as express.ErrorRequestHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await settle(800);
  globalThis.fetch = realFetch;
  const bookingIds = (await prisma.booking.findMany({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { email: { startsWith: "zz-f3b-" } }] }, select: { id: true } })).map((b) => b.id);
  const leadIds = (await prisma.lead.findMany({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { contact: { contains: "zz-f3b-" } }] }, select: { id: true } })).map((l) => l.id);
  const requestIds = (await prisma.designRequest.findMany({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { email: { startsWith: "zz-f3b-" } }] }, select: { id: true } })).map((r) => r.id);
  const counts = {
    notifications: (await prisma.notification.deleteMany({ where: { accountId, OR: [{ body: { contains: ZZ } }, { bookingId: { in: bookingIds } }, { leadId: { in: leadIds } }] } })).count,
    messages: (await prisma.messageLog.deleteMany({ where: { accountId, OR: [{ bookingId: { in: bookingIds } }, { designRequestId: { in: requestIds } }, { leadId: { in: leadIds } }] } })).count,
    requests: (await prisma.designRequest.deleteMany({ where: { id: { in: requestIds } } })).count,
    bookings: (await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } })).count,
    leads: (await prisma.lead.deleteMany({ where: { id: { in: leadIds } } })).count,
    customers: (await prisma.customer.deleteMany({ where: { id: { in: made.customers } } })).count,
    items: (await prisma.item.deleteMany({ where: { id: { in: made.items } } })).count,
    policies: (await prisma.policyVersion.deleteMany({ where: { id: { in: made.policies } } }).catch(() => ({ count: -1 }))).count,
    statuses: (await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } }).catch(() => ({ count: -1 }))).count,
  };
  if (settingsBefore) await prisma.account.update({ where: { id: accountId }, data: settingsBefore as object });
  console.log("cleanup", JSON.stringify(counts), "remaining", JSON.stringify({ bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }), leads: await prisma.lead.count({ where: { customerName: { startsWith: ZZ } } }) }));
  await prisma.$disconnect();
});

type PayView = { step: string; policy: { id: string; version: number; text: string } | null; policyRequired: boolean; policyAccepted: boolean; policyAcceptedAt: string | null; items: { name: string; quantity: number }[]; package: string | null; balance: number | null; balanceDueDate: string | null; guestCount: number | null };
type Summary = { row: { status: string; needs: { code: string; label: string }[]; nextAction: { code: string; label: string } }; paperwork: { path: string; policy: { by: string; via: string | null; line: string; acceptedText: string | null } }; money: { total: number; owedNow: number; balanceDueDate: string }; history: { text: string }[]; where: { setupNotes: string | null; guestCount: number | null } };

test("a phone booking needs no staff tick; the customer accepts the policy on the pay link, once, with the version and text", async () => {
  n += 1;
  const made1 = await post("/api/bookings/staff", { customerName: `${ZZ} F3b Phone ${n}`, phone: "860-555-0611", email: `zz-f3b-phone-${n}@example.test`, itemIds: [bar], quantities: { [bar]: 2 }, eventDate: day(60), setupNotes: "Back patio, gate code 4410", sendPayLink: false });
  assert.equal(made1.status, 201, JSON.stringify(made1.json));
  const id = made1.json.bookingId as string;
  const token = (await prisma.booking.findUniqueOrThrow({ where: { id } })).payToken as string;

  // Staff see it under Needs action, with the reasons in words.
  let s = (await get(`/api/bookings/${id}/summary`)).json as unknown as Summary;
  assert.deepEqual(s.row.needs.map((x) => x.code), ["policy", "retainer"]);
  assert.equal(s.row.status, "Awaiting retainer");
  assert.equal(s.row.nextAction.label, "Send pay link");
  assert.equal(s.paperwork.policy.by, "nobody");
  assert.equal(s.where.setupNotes, "Back patio, gate code 4410");

  // The pay link's data: the items, the balance due date, and the policy state.
  let pay = (await get(`/api/pay/${token}`)).json as unknown as PayView;
  assert.deepEqual([pay.step, pay.policyRequired, pay.policyAccepted, pay.policyAcceptedAt], ["retainer", true, false, null]);
  assert.deepEqual(pay.items, [{ name: `${ZZ} F3b Portable Bar`, quantity: 2 }]);
  assert.equal(pay.balanceDueDate, day(60 - 14));
  assert.equal(pay.balance, 360);
  assert.ok(pay.policy && !/\{\{/.test(pay.policy.text));

  // Ticking the box. Without accept: true nothing is recorded.
  assert.equal((await post(`/api/pay/${token}/policy`, {})).status, 400);
  assert.equal((await post(`/api/pay/not-a-real-token-000000000000/policy`, { accept: true })).status, 404);
  // A policy the screen did not show is refused, with the current one to read.
  const stale = await post(`/api/pay/${token}/policy`, { accept: true, policyId: "some-old-version" });
  assert.deepEqual([stale.status, stale.json.reason, (stale.json.policy as { id: string }).id], [409, "policy-changed", pay.policy!.id]);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id } })).policyAcceptedAt, null);

  const ok = await post(`/api/pay/${token}/policy`, { accept: true, policyId: pay.policy!.id });
  assert.deepEqual([ok.status, ok.json.policyAccepted, ok.json.policyVersion], [201, true, pay.policy!.version]);
  const stored = await prisma.booking.findUniqueOrThrow({ where: { id } });
  assert.ok(stored.policyAcceptedAt);
  assert.deepEqual([stored.policyAcceptedVersionId, stored.policyAcceptedVersion, stored.policyAcceptedText], [pay.policy!.id, pay.policy!.version, pay.policy!.text], "the exact version and the exact text they saw");
  // Again: the first acceptance stands.
  const again = await post(`/api/pay/${token}/policy`, { accept: true });
  assert.deepEqual([again.status, again.json.policyAcceptedAt], [200, stored.policyAcceptedAt!.toISOString()]);

  pay = (await get(`/api/pay/${token}`)).json as unknown as PayView;
  assert.deepEqual([pay.policyAccepted, pay.policyAcceptedAt], [true, stored.policyAcceptedAt!.toISOString()]);
  s = (await get(`/api/bookings/${id}/summary`)).json as unknown as Summary;
  assert.deepEqual(s.row.needs.map((x) => x.code), ["retainer"]);
  assert.match(s.paperwork.policy.line, /^Policy accepted by customer on .+, on the pay page/);
  assert.equal(s.paperwork.policy.acceptedText, pay.policy!.text);
  assert.ok(s.history.some((h) => /accepted the rental policy/.test(h.text)));
  // Nothing about payment or the booking's state moved.
  assert.deepEqual([stored.status, stored.retainerPaid, stored.confirmedAt], ["Held", false, null]);

  // The list: this booking is in Needs action and Upcoming, with one status.
  const list = (await get("/api/bookings/list")).json as unknown as { views: { key: string; label: string; count: number }[]; rows: { id: string; views: string[]; status: string; items: string; needs: { label: string }[] }[] };
  const row = list.rows.find((r) => r.id === id)!;
  assert.deepEqual([row.views, row.status, row.items, row.needs.map((x) => x.label)], [["needs-action", "upcoming"], "Awaiting retainer", `${ZZ} F3b Portable Bar x 2`, ["Retainer unpaid, $90.00"]]);
  for (const v of list.views) assert.equal(v.count, list.rows.filter((r) => r.views.includes(v.key)).length, v.label);
});

test("the staff tick is kept as a record of a phone agreement, and a contract booking has no policy to accept", async () => {
  n += 1;
  const ticked = await post("/api/bookings/staff", { customerName: `${ZZ} F3b Ticked ${n}`, phone: "860-555-0612", email: `zz-f3b-ticked-${n}@example.test`, itemIds: [bar], eventDate: day(61), agreed: true, sendPayLink: false });
  assert.equal(ticked.status, 201, JSON.stringify(ticked.json));
  const s = (await get(`/api/bookings/${ticked.json.bookingId as string}/summary`)).json as unknown as Summary;
  assert.deepEqual([s.paperwork.policy.by, s.paperwork.policy.via], ["staff", "phone"]);
  assert.deepEqual(s.row.needs.map((x) => x.code), ["retainer"], "confirmed by phone is not flagged as missing");

  const big = await post("/api/bookings/staff", { customerName: `${ZZ} F3b Contract ${n}`, phone: "860-555-0613", email: `zz-f3b-contract-${n}@example.test`, itemIds: [hall], eventDate: day(62), sendPayLink: false });
  assert.equal(big.status, 201, JSON.stringify(big.json));
  const bigId = big.json.bookingId as string;
  const c = (await get(`/api/bookings/${bigId}/summary`)).json as unknown as Summary;
  assert.deepEqual([c.paperwork.path, c.row.status, c.row.needs.map((x) => x.code), c.row.nextAction.label], ["contract", "Awaiting contract", ["unsigned"], "Send contract link"]);
  const token = (await prisma.booking.findUniqueOrThrow({ where: { id: bigId } })).payToken as string;
  const pay = (await get(`/api/pay/${token}`)).json as unknown as PayView;
  assert.deepEqual([pay.step, pay.policy, pay.policyRequired, pay.policyAccepted], ["sign", null, false, false]);
  assert.deepEqual([(await post(`/api/pay/${token}/policy`, { accept: true })).status, (await post(`/api/pay/${token}/policy`, { accept: true })).json.reason], [409, "not-needed"]);
});

test("New booking's review step: the retainer, policy or contract and why, and whether it goes to review", async () => {
  const small = (await post("/api/bookings/staff/preview", { itemIds: [bar], total: 225, occasion: "Birthday" })).json as { path: string; why: string; retainer: number; review: { required: boolean } };
  assert.deepEqual([small.path, small.retainer, small.review.required], ["policy", 45, false]);
  assert.match(small.why, /short rental policy because the total is \$1,000\.00 or less/);
  const big = (await post("/api/bookings/staff/preview", { itemIds: [hall], total: 2500 })).json as { path: string; why: string; retainer: number };
  assert.deepEqual([big.path, big.retainer], ["contract", 500]);
  assert.match(big.why, /signs the contract because the total is over \$1,000\.00/);
  const wedding = (await post("/api/bookings/staff/preview", { itemIds: [hall], total: 5000, occasion: "Wedding" })).json as { review: { required: boolean; sentence: string } };
  assert.equal(wedding.review.required, true);
  assert.ok(wedding.review.sentence.length > 10);
});

test("a customer's bookings carry the guest count, whether the policy is accepted, and the outcome of a request to cancel", async () => {
  const who = await signup("Member", "860-555-0621");
  const held = await post("/api/bookings/direct", { itemId: bar, eventDate: day(70), agreedToPolicy: true, delivery: null, tier: 1 }, who.cookie);
  assert.equal(held.status, 201, JSON.stringify(held.json));
  const id = held.json.bookingId as string;
  await prisma.booking.update({ where: { id }, data: { guestCount: 80 } });
  type Mine = { id: string; guestCount: number | null; policyRequired: boolean; policyAccepted: boolean; policyAcceptedAt: string | null; pendingRequest: { id: string } | null; cancellation: { id: string; status: string; requestedAt: string; decidedAt: string | null } | null };
  const mine = async () => ((await get("/api/customer/bookings", who.cookie)).json as unknown as Mine[]).find((b) => b.id === id)!;
  let b = await mine();
  assert.deepEqual([b.guestCount, b.policyRequired, b.policyAccepted, b.cancellation], [80, true, true, null], "they ticked the box at checkout");
  assert.ok(b.policyAcceptedAt);

  // A booking staff made for the same account: not accepted until the pay link.
  const phone = await post("/api/bookings/staff", { customerId: who.id, customerName: who.name, itemIds: [bar], eventDate: day(71), agreed: true, sendPayLink: false });
  assert.equal(phone.status, 201, JSON.stringify(phone.json));
  const other = ((await get("/api/customer/bookings", who.cookie)).json as unknown as Mine[]).find((x) => x.id === phone.json.bookingId)!;
  assert.deepEqual([other.policyRequired, other.policyAccepted, other.policyAcceptedAt], [true, false, null], "a staff tick is not the customer's acceptance");

  // Ask to cancel: waiting, then declined with the date, with no device memory.
  const asked = await post(`/api/customer/bookings/${id}/cancel`, { reason: "We moved the party" }, who.cookie);
  assert.equal(asked.status, 202, JSON.stringify(asked.json));
  b = await mine();
  assert.deepEqual([b.cancellation?.status, b.cancellation?.decidedAt, b.pendingRequest?.id], ["waiting", null, b.cancellation?.id]);
  const list = (await get("/api/bookings/list")).json as unknown as { rows: { id: string; status: string; needs: { code: string }[] }[] };
  assert.deepEqual([list.rows.find((r) => r.id === id)!.status, list.rows.find((r) => r.id === id)!.needs[0].code], ["Cancellation requested", "cancellation"]);
  await decideCancellation(b.cancellation!.id, accountId, "decline", null);
  b = await mine();
  assert.deepEqual([b.cancellation?.status, b.pendingRequest], ["declined", null]);
  assert.ok(b.cancellation?.decidedAt);
  // A second request, approved: the newest one is the outcome shown.
  assert.equal((await post(`/api/customer/bookings/${id}/cancel`, { reason: "Still need to cancel" }, who.cookie)).status, 202);
  const second = (await mine()).cancellation!;
  assert.equal(second.status, "waiting");
  await decideCancellation(second.id, accountId, "approve", null);
  b = await mine();
  assert.deepEqual([b.cancellation?.id, b.cancellation?.status, b.pendingRequest], [second.id, "approved", null]);
});

test("a storefront request makes a lead the moment it arrives; converting and dismissing update that same lead", async () => {
  const who = await signup("Asker", "860-555-0631");
  const leadsOf = () => prisma.lead.findMany({ where: { accountId, contact: { contains: who.email } }, include: { activities: true } });
  await prisma.item.update({ where: { id: hall }, data: { price: 5000 } });
  const sent = await post("/api/bookings/direct", { itemId: hall, eventDate: day(80), occasion: "Holiday party", agreedToPolicy: true, delivery: null, address: null }, who.cookie);
  const sent2 = await post("/api/bookings/direct", { itemId: hall, eventDate: day(81), occasion: "Holiday party", agreedToPolicy: true, delivery: null, address: null }, who.cookie);
  await prisma.item.update({ where: { id: hall }, data: { price: 2500 } });
  assert.deepEqual([sent.status, sent2.status], [202, 202], JSON.stringify([sent.json, sent2.json]));
  const requestId = sent.json.designRequestId as string;
  const request2 = sent2.json.designRequestId as string;

  let leads = await leadsOf();
  assert.equal(leads.length, 1, "one lead: the second request found the first one's lead, no duplicate");
  const lead = leads[0];
  assert.deepEqual([lead.source, lead.status], ["storefront", "New"]);
  assert.deepEqual((await prisma.designRequest.findMany({ where: { id: { in: [requestId, request2] } }, select: { leadId: true } })).map((r) => r.leadId), [lead.id, lead.id]);
  assert.equal(lead.activities.filter((a) => /^Sent a request for/.test(a.text)).length, 2);

  let box = await inbox();
  const rows = box.rows.filter((r) => r.id === lead.id || r.key.startsWith("request:"));
  assert.deepEqual(rows.filter((r) => r.id === lead.id).map((r) => [r.kind, r.source, r.stage, r.tabs.includes("all"), r.tabs.includes("requests")]), [["lead", "Storefront", "Storefront request", true, true]]);
  assert.equal(box.rows.some((r) => r.key === `request:${requestId}` || r.key === `request:${request2}`), false, "no second row for the request");
  const today = (await get("/api/today")).json as unknown as { columns: { groups: { key: string; items: { open: { kind: string; id: string }; button: string }[] }[] }[] };
  const waiting = today.columns[0].groups.find((g) => g.key === "requests")!.items;
  assert.ok(waiting.some((i) => i.open.kind === "request" && i.button === "Review"));
  assert.equal(today.columns[0].groups.find((g) => g.key === "new-leads")!.items.some((i) => i.open.id === lead.id), false, "listed once on Today");

  // Dismiss the second: with the first still open the lead stays put.
  const gone = await patch(`/api/design-requests/${request2}`, { status: "Dismissed", reason: "Duplicate of the first" });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  leads = await leadsOf();
  assert.equal(leads[0].status, "Lost", "dismissing closes the lead");
  // Reopen brings the same lead back.
  assert.equal((await patch(`/api/design-requests/${request2}`, { status: "Open" })).status, 200);
  assert.equal((await leadsOf())[0].status, "New");
  assert.equal((await patch(`/api/design-requests/${request2}`, { status: "Dismissed", reason: "Duplicate of the first" })).status, 200);
  assert.equal((await patch(`/api/leads/${lead.id}`, { status: "New" })).status, 200);

  // Convert the first: the booking hangs on that same lead, which moves to Booked.
  const c = await post("/api/bookings/staff", { designRequestId: requestId, customerId: who.id, customerName: who.name, itemIds: [hall], eventDate: day(80), occasion: "Holiday party", total: 800, sendPayLink: false });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  leads = await leadsOf();
  assert.equal(leads.length, 1, "still one lead");
  assert.deepEqual([leads[0].id, leads[0].status, leads[0].source], [lead.id, "Booked", "storefront"]);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: c.json.bookingId as string } })).leadId, lead.id);
  assert.ok(leads[0].activities.some((a) => /Made from this lead's storefront request/.test(a.text)));
  box = await inbox();
  const after = box.rows.filter((r) => r.id === lead.id);
  assert.deepEqual(after.map((r) => [r.kind, r.bucket, r.requestId, r.bookingId]), [["lead", "booked", null, c.json.bookingId]]);
  // The policy on a converted request: the customer ticked it in the store.
  const s = (await get(`/api/bookings/${c.json.bookingId as string}/summary`)).json as unknown as Summary;
  assert.deepEqual([s.paperwork.policy.by, s.paperwork.policy.via], ["customer", "checkout"]);
  for (const t of box.tabs) assert.equal(t.count, box.rows.filter((r) => r.tabs.includes(t.key)).length, t.key);
});

test("automatic follow ups to a lead stop as soon as staff log a contact or set a follow up date", async () => {
  const add = async () => {
    n += 1;
    const r = await post("/api/leads", { customerName: `${ZZ} F3b Lead ${n}`, contact: `(860) 555-06${String(40 + n).padStart(2, "0")}, zz-f3b-lead-${n}@example.test`, occasion: "40th birthday", source: "phone" });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.id as string;
  };
  const plan = async (id: string) => (await loadPlans({ leadId: id }))[0].plan.items.filter((i) => i.seriesId === "lead_nurture");
  const one = await add();
  let items = await plan(one);
  assert.ok(items.length >= 2, "day 3 and day 10");
  assert.ok(items.every((i) => i.state === "scheduled"), JSON.stringify(items.map((i) => [i.state, i.reason])));
  assert.equal((await post(`/api/leads/${one}/contact`, { kind: "call", note: "Left a voicemail" })).status, 201);
  items = await plan(one);
  assert.ok(items.every((i) => i.state === "stopped" && i.reason === "Stopped: staff logged a contact"), JSON.stringify(items.map((i) => [i.state, i.reason])));

  const two = await add();
  assert.ok((await plan(two)).every((i) => i.state === "scheduled"));
  assert.equal((await post(`/api/leads/${two}/follow-up`, { date: day(5), note: "Call after the weekend" })).status, 200);
  items = await plan(two);
  assert.ok(items.every((i) => i.state === "stopped" && i.reason === "Stopped: staff set a follow up date"), JSON.stringify(items.map((i) => [i.state, i.reason])));
});
