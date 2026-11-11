// Block F3a, the command center. First the rules with no database (which
// view a lead is in, the next action, follow up dates, matching a booking to
// a lead, the Today columns), then over HTTP on a throwaway database: a
// booking links to its lead, the lead actions, the inbox counts, the Today
// view, the contract wording with the retainer amount, and the pay link
// switch. Twilio, the email webhook and Stripe are stubbed.
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
import { addDays } from "../automation/time.js";
import { prisma } from "../db.js";
import { INBOX_TABS, bucketOf, buildInbox, contactParts, matchLead, nextActionFor, sourceWords, type InboxLead, type InboxRequest, type MatchLead } from "../inbox.js";
import { payLinkFor } from "../payLink.js";
import { customerWriteGuard } from "../security.js";
import { buildToday, type TodayBooking } from "../today.js";
import customerRouter from "../routes/customer.js";
import designRequestsRouter from "../routes/designRequests.js";
import directBookingsRouter, { staffBookingRouter } from "../routes/directBookings.js";
import { inboxRouter, leadActionsRouter, todayRouter } from "../routes/inbox.js";
import leadsRouter from "../routes/leads.js";
import messagesRouter from "../routes/messages.js";
import tierRouter from "../routes/tier.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("f3aCommandCenter.test.ts runs only against a throwaway database (name containing zz_scratch)");

// ---- the rules, with no database ---------------------------------------------------
const TODAY = "2026-11-16";
const at = (day: string, hour = 12) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
const COLUMNS = ["New", "Contacted", "Proposal sent", "Booked", "Lost"];
const lead = (over: Partial<InboxLead> = {}): InboxLead => ({ id: "L1", status: "New", source: "website", customerName: "Sarah Miller", contact: "Sarah, (860) 555-0142, sarah@example.com", occasion: "Sweet 16", dateOfInterest: null, notes: null, theme: null, itemsReturned: null, tags: [], createdAt: at("2026-11-14"), updatedAt: at("2026-11-14"), firstContactedAt: null, lastContactedAt: null, followUpOn: null, followUpNote: null, lostReason: null, bookings: [], ...over });
const booking = (over: Partial<InboxLead["bookings"][number]> = {}): InboxLead["bookings"][number] => ({ id: "B1", status: "Held", eventDate: at("2026-12-20", 0), tier: 1, retainerPaid: false, total: 225, createdAt: at("2026-11-15"), agreement: null, designRequest: null, cancellationRequests: [], itemNames: ["Portable Bar"], packageName: null, ...over });
const request = (over: Partial<InboxRequest> = {}): InboxRequest => ({ id: "R1", status: "Open", customerName: "Dana Lee", phone: "8605550111", email: "dana@example.com", occasion: "Reception only", eventDate: at("2026-12-26", 0), total: 5400, cart: { items: [{ name: "Grand Tent", quantity: 1 }], addons: [], package: null }, createdAt: at("2026-11-15"), dismissReason: null, ...over });

describe("which view a lead is in", () => {
  test("every lead is in exactly one of new, follow up, booked, lost", () => {
    assert.equal(bucketOf(lead(), "New"), "new");
    assert.equal(bucketOf(lead({ firstContactedAt: at("2026-11-15"), status: "Contacted" }), "New"), "follow-up");
    assert.equal(bucketOf(lead({ status: "Contacted" }), "New"), "follow-up", "a lead staff moved by hand before F3a is not new");
    assert.equal(bucketOf(lead({ bookings: [booking()] }), "New"), "booked");
    assert.equal(bucketOf(lead({ status: "Booked" }), "New"), "booked", "marked Booked by hand");
    assert.equal(bucketOf(lead({ status: "Lost" }), "New"), "lost");
    assert.equal(bucketOf(lead({ status: "Booked", bookings: [booking({ status: "Cancelled" })] }), "New"), "lost", "its only booking was cancelled");
    assert.equal(bucketOf(lead({ status: "Lost", bookings: [booking()] }), "New"), "booked", "a live booking wins");
  });

  test("the source is said in words", () => {
    assert.deepEqual(["website", "storefront", "ask-go", "concierge", "phone", "manual"].map(sourceWords), ["Website form", "Storefront", "Ask GO", "Talk to us", "Phone or in person", "Staff"]);
  });

  test("the tabs' counts: each row is counted in All and in its own views", () => {
    const leads = [
      lead({ id: "new1" }),
      lead({ id: "new2", source: "ask-go" }),
      lead({ id: "fu1", status: "Contacted", firstContactedAt: at("2026-11-15") }),
      lead({ id: "bk1", status: "Booked", bookings: [booking({ retainerPaid: true })] }),
      lead({ id: "bk2", status: "Booked", bookings: [booking({ id: "B2", cancellationRequests: [{ id: "C1", status: "Open", createdAt: at("2026-11-15") }] })] }),
      lead({ id: "lost1", status: "Lost", lostReason: "Price" }),
    ];
    const requests = [request(), request({ id: "R2", status: "Dismissed", dismissReason: "Out of our area" }), request({ id: "R3", status: "Converted" })];
    const { rows, counts } = buildInbox(leads, requests, COLUMNS, TODAY);
    assert.deepEqual(counts, { all: 8, new: 2, requests: 1, cancellations: 1, "follow-up": 1, booked: 2, lost: 2 });
    assert.equal(rows.length, 8, "a converted request is not a row: its booking's lead is");
    assert.deepEqual(INBOX_TABS.map((t) => t.label), ["All", "New", "Storefront requests", "Cancellation requests", "Follow up", "Booked", "Lost"]);
    assert.ok(rows.findIndex((r) => r.nextAction.urgent === false) > rows.findIndex((r) => r.nextAction.urgent), "what needs doing comes first");
    const r = rows.find((x) => x.id === "new1")!;
    assert.deepEqual([r.source, r.name, r.phone, r.email, r.wants, r.ageDays, r.nextAction.label], ["Website form", "Sarah Miller", "8605550142", "sarah@example.com", "Sweet 16", 2, "Contact them"]);
    const q = rows.find((x) => x.key === "request:R1")!;
    assert.deepEqual([q.source, q.wants, q.eventDate, q.nextAction.label], ["Storefront", "Grand Tent", "2026-12-26", "Review it, then convert or dismiss"]);
    assert.equal(rows.find((x) => x.id === "bk2")!.nextAction.label, "Approve or decline the cancellation request");
  });
});

describe("follow up dates and the next action", () => {
  const contacted = (over: Partial<InboxLead> = {}) => lead({ status: "Contacted", firstContactedAt: at("2026-11-10"), lastContactedAt: at("2026-11-15"), ...over });
  const next = (l: InboxLead) => nextActionFor(l, bucketOf(l, "New"), TODAY);

  test("a follow up is due on its day, overdue after it, and quiet before it", () => {
    assert.deepEqual(next(contacted({ followUpOn: at("2026-11-16", 0) })), { code: "follow-up-today", label: "Follow up today", urgent: true });
    assert.deepEqual(next(contacted({ followUpOn: at("2026-11-13", 0) })), { code: "follow-up-late", label: "Follow up, 3 days overdue", urgent: true });
    assert.deepEqual(next(contacted({ followUpOn: at("2026-11-15", 0) })).label, "Follow up, 1 day overdue");
    assert.deepEqual(next(contacted({ followUpOn: at("2026-11-20", 0) })), { code: "follow-up-later", label: "Follow up Fri, Nov 20", urgent: false });
  });

  test("a contacted lead with no next step is flagged after 3 days, not before", () => {
    assert.equal(next(contacted({ lastContactedAt: at("2026-11-15") })).code, "set-next-step");
    assert.equal(next(contacted({ lastContactedAt: at("2026-11-14") })).code, "set-next-step");
    assert.deepEqual(next(contacted({ lastContactedAt: at("2026-11-13") })), { code: "no-next-step", label: "No next step for 3 days. Set one.", urgent: true });
  });

  test("a booked lead says what it is waiting on", () => {
    assert.equal(next(lead({ bookings: [booking({ tier: 2, agreement: { contractStatus: "Sent" } })] })).label, "Waiting on the contract signature");
    assert.equal(next(lead({ bookings: [booking()] })).label, "Waiting on the retainer");
    assert.equal(next(lead({ bookings: [booking({ retainerPaid: true })] })).label, "Booked. Nothing to do.");
    assert.equal(next(lead({ status: "Lost", lostReason: "Price" })).label, "Closed: Price");
  });
});

describe("matching a booking to a lead", () => {
  const now = at("2026-11-16");
  const m = (over: Partial<MatchLead> = {}): MatchLead => ({ id: "L1", status: "Contacted", customerName: "Sarah Miller", contact: "Sarah Miller, 860-555-0142, Sarah@Example.com", createdAt: at("2026-11-01"), bookings: [], ...over });

  test("the contact line is read for an email and a ten digit phone", () => {
    assert.deepEqual(contactParts("Sarah, +1 (860) 555-0142 · Sarah@Example.com"), { email: "sarah@example.com", phone: "8605550142" });
    assert.deepEqual(contactParts("call after 5"), { email: null, phone: null });
  });

  test("exact: the same email (any case) or the same phone, on an open lead; the newest wins", () => {
    assert.equal(matchLead([m()], { name: "S Miller", email: "sarah@example.com", phone: null }, now).exact?.id, "L1");
    assert.equal(matchLead([m()], { name: "Someone Else", email: "other@example.com", phone: "(860) 555-0142" }, now).exact?.id, "L1");
    const two = matchLead([m({ id: "old", createdAt: at("2026-10-01") }), m({ id: "newer", createdAt: at("2026-11-10") })], { name: null, email: "sarah@example.com", phone: null }, now);
    assert.equal(two.exact?.id, "newer");
    assert.deepEqual(two.near.map((n) => n.id), ["old"], "the other one is noted, not linked");
  });

  test("near: the same name with other contact details, or the same contact on a closed or booked lead, is never linked", () => {
    const sameName = matchLead([m({ contact: "Sarah Miller, 203-555-0199" })], { name: "sarah  miller", email: "new@example.com", phone: "8605550000" }, now);
    assert.equal(sameName.exact, null);
    assert.deepEqual(sameName.near.map((n) => n.id), ["L1"]);
    for (const closed of [m({ status: "Lost" }), m({ bookings: [{ status: "Held" }] }), m({ createdAt: at("2026-01-01") })]) {
      const r = matchLead([closed], { name: null, email: "sarah@example.com", phone: null }, now);
      assert.equal(r.exact, null);
      assert.equal(r.near.length, 1);
    }
    assert.equal(matchLead([m({ bookings: [{ status: "Cancelled" }] })], { name: null, email: "sarah@example.com", phone: null }, now).exact?.id, "L1", "a cancelled booking does not close the lead");
    assert.deepEqual(matchLead([m()], { name: "Nobody", email: "x@example.com", phone: "2035550100" }, now), { exact: null, near: [] });
  });
});

describe("the Today columns", () => {
  const tb = (over: Partial<TodayBooking> = {}): TodayBooking => ({ id: "B1", leadId: "L1", customerName: "Sarah Miller", eventDate: "2026-12-20", eventTime: "2 PM", stage: "Held", needsSignature: false, contractSentAt: null, retainerOwedCents: null, payLinkSentAt: null, balanceOwedCents: null, balanceDueDate: null, weddingDetailsMissing: false, ...over });
  const leads = [
    lead({ id: "new1" }),
    lead({ id: "due", status: "Contacted", firstContactedAt: at("2026-11-01"), lastContactedAt: at("2026-11-15"), followUpOn: at("2026-11-16", 0) }),
    lead({ id: "later", status: "Contacted", firstContactedAt: at("2026-11-01"), lastContactedAt: at("2026-11-15"), followUpOn: at("2026-11-25", 0) }),
    lead({ id: "idle", status: "Contacted", firstContactedAt: at("2026-11-01"), lastContactedAt: at("2026-11-10") }),
    lead({ id: "cancel", status: "Booked", bookings: [booking({ id: "B9", cancellationRequests: [{ id: "C1", status: "Open", createdAt: at("2026-11-15") }] })] }),
  ];
  const { rows } = buildInbox(leads, [request()], COLUMNS, TODAY);
  const bookings = [
    tb({ id: "unsigned", needsSignature: true, contractSentAt: "2026-11-12T15:00:00.000Z", retainerOwedCents: 50000 }),
    tb({ id: "unpaid", retainerOwedCents: 4500 }),
    tb({ id: "balance-soon", balanceOwedCents: 18000, balanceDueDate: "2026-11-28" }),
    tb({ id: "balance-late", balanceOwedCents: 52000, balanceDueDate: "2026-11-01" }),
    tb({ id: "balance-far", balanceOwedCents: 9000, balanceDueDate: "2026-12-15" }),
    tb({ id: "wedding-soon", eventDate: "2026-12-28", weddingDetailsMissing: true }),
    tb({ id: "wedding-far", eventDate: "2027-03-01", weddingDetailsMissing: true }),
    tb({ id: "this-week", eventDate: "2026-11-20" }),
  ];
  const columns = buildToday(rows, bookings, TODAY);
  const ids = (col: string, group: string) => columns.find((c) => c.key === col)!.groups.find((g) => g.key === group)!.items.map((i) => i.open.id);

  test("Close the sale: new leads, storefront requests, contracts unsigned, retainers unpaid", () => {
    assert.deepEqual(ids("close", "new-leads"), ["new1"]);
    assert.deepEqual(ids("close", "requests"), ["R1"]);
    assert.deepEqual(ids("close", "unsigned"), ["unsigned"]);
    assert.deepEqual(ids("close", "unpaid"), ["unpaid"], "an unsigned contract is not also listed as an unpaid retainer");
    assert.equal(columns[0].count, 4);
  });

  test("Nurture: follow ups due today or overdue, and contacted leads with no next step for 3 days", () => {
    assert.deepEqual(ids("nurture", "follow-ups"), ["due"], "a follow up set for next week is not on Today");
    assert.deepEqual(ids("nurture", "no-next-step"), ["idle"]);
    assert.equal(columns[1].count, 2);
  });

  test("After the sale: cancellation requests, balances within 14 days, wedding details within 45 days, events within 7 days", () => {
    assert.deepEqual(ids("after", "cancellations"), ["cancel"]);
    assert.deepEqual(ids("after", "balances"), ["balance-late", "balance-soon"], "late ones first; one due in a month is not listed");
    assert.deepEqual(ids("after", "wedding-details"), ["wedding-soon"]);
    assert.deepEqual(ids("after", "events"), ["this-week"]);
    assert.equal(columns[2].count, 5);
  });

  test("every item is one line with a button, and an empty column says so in plain words", () => {
    const item = columns[0].groups[0].items[0];
    assert.equal(item.title, "Sarah Miller · Website form");
    assert.equal(item.button, "Contact");
    assert.deepEqual(item.open, { kind: "lead", id: "new1" });
    assert.equal(columns[0].groups[3].items[0].button, "Send pay link");
    const empty = buildToday([], [], TODAY);
    assert.deepEqual(empty.map((c) => c.count), [0, 0, 0]);
    assert.match(empty[0].empty, /Nothing is waiting to be closed/);
    assert.match(empty[1].empty, /No follow ups are due/);
    assert.match(empty[2].empty, /Nothing needs attention/);
  });
});

test("the pay link points at the admin, or at the store's pay page when the switch is on", () => {
  assert.equal(payLinkFor("abc123"), "https://api.test/pay/abc123");
  assert.equal(payLinkFor("abc123", false), "https://api.test/pay/abc123");
  assert.equal(payLinkFor("abc123", true), "https://store.test/pay/abc123");
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
const emails: { to: string; subject: string; body: string }[] = [];
const texts: { to: string; body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) {
    const b = new URLSearchParams(String(init?.body));
    texts.push({ to: b.get("To") ?? "", body: b.get("Body") ?? "" });
    return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
  }
  if (url.startsWith("http://stub.invalid/")) {
    const b = JSON.parse(String(init?.body ?? "{}")) as { to?: string; subject?: string; body?: string; text?: string };
    emails.push({ to: b.to ?? "", subject: b.subject ?? "", body: b.body ?? b.text ?? "" });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }
  return realFetch(input, init);
}) as typeof fetch;

type Res = { status: number; json: Record<string, unknown>; cookie: string | null };
let ipCount = 0;
async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res> {
  ipCount += 1;
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://store.test", "X-Forwarded-For": `10.7.${Math.floor(ipCount / 200)}.${ipCount % 200}` };
  if (init.cookie) headers.Cookie = init.cookie;
  const r = await realFetch(`${base}${path}`, { ...init, headers });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown>, cookie: set ? set.split(";")[0] : null };
}
const post = (path: string, body: unknown, cookie?: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const get = (path: string, cookie?: string) => call(path, { cookie });
const day = (n: number) => addDays(new Date().toISOString().slice(0, 10), n);
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const leadCount = () => prisma.lead.count({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { contact: { contains: "zz-f3a-" } }] } });
async function addLead(over: Record<string, unknown> = {}) {
  n += 1;
  const r = await post("/api/leads", { customerName: `${ZZ} F3a Lead ${n}`, contact: `(860) 555-05${String(n).padStart(2, "0")}, zz-f3a-${n}@example.test`, occasion: "40th birthday", source: "phone", ...over });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json as { id: string; status: string; source: string; contact: string };
}
type Tab = { key: string; label: string; count: number };
type Row = { key: string; kind: string; id: string; tabs: string[]; bucket: string; source: string; stage: string; nextAction: { code: string; label: string }; bookingId: string | null; followUpOn: string | null };
const inbox = async () => (await get("/api/inbox")).json as unknown as { tabs: Tab[]; rows: Row[]; lostReasons: string[] };
const rowOf = async (id: string) => (await inbox()).rows.find((r) => r.id === id)!;

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  settingsBefore = { reviewAmountKids: a.reviewAmountKids, reviewAmountAdult: a.reviewAmountAdult, reviewAmountWedding: a.reviewAmountWedding, reviewAmountCorporate: a.reviewAmountCorporate, reviewAmountDefault: a.reviewAmountDefault, contractRequiredOver: a.contractRequiredOver, contractRequiredForCrewed: a.contractRequiredForCrewed, requireAgreementCheckbox: a.requireAgreementCheckbox, requireCustomerAccount: a.requireCustomerAccount, directBookingDailyCap: a.directBookingDailyCap, requireBotCheck: a.requireBotCheck, depositPercentage: a.depositPercentage, tier1Collect: a.tier1Collect, useGoContract: a.useGoContract, holdReminderEmails: a.holdReminderEmails, payLinksOpenStorefront: a.payLinksOpenStorefront, automationStartedAt: a.automationStartedAt };
  await prisma.account.update({ where: { id: accountId }, data: { reviewAmountKids: 10000, reviewAmountAdult: 10000, reviewAmountWedding: 5000, reviewAmountCorporate: 5000, reviewAmountDefault: 10000, contractRequiredOver: 1000, contractRequiredForCrewed: true, requireAgreementCheckbox: false, requireCustomerAccount: false, directBookingDailyCap: 1000, requireBotCheck: false, depositPercentage: 20, tier1Collect: "retainer", useGoContract: false, holdReminderEmails: true, payLinksOpenStorefront: false, automationStartedAt: new Date(Date.now() - 86_400_000) } });
  await prisma.customer.deleteMany({ where: { accountId, email: { startsWith: "zz-f3a-" } } });
  // The columns the owner has: New, Contacted, Booked, Lost.
  for (const [i, name] of ["New", "Contacted", "Booked", "Lost"].entries()) {
    if ((await prisma.leadStatus.count({ where: { accountId, name } })) === 0) made.statuses.push((await prisma.leadStatus.create({ data: { accountId, name, position: i } })).id);
  }
  const policy = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  if (!policy || policy.text.trim() === "") made.policies.push((await prisma.policyVersion.create({ data: { accountId, version: (policy?.version ?? 0) + 1, text: `${ZZ} rental policy: the retainer is {{depositPercentage}}% and non-refundable.` } })).id);
  const mk = async (name: string, category: string, price: number) => {
    const item = await prisma.item.create({ data: { accountId, name: `${ZZ} F3a ${name}`, category, price, units: { create: Array.from({ length: 20 }, (_, i) => ({ label: String(i + 1) })) } } });
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
  app.use("/api/bookings/direct", directBookingsRouter);
  app.use("/api/bookings/tier", tierRouter);
  app.use("/api/bookings/staff", staff, staffBookingRouter);
  app.use("/api/design-requests", staff, designRequestsRouter);
  app.use("/api/inbox", staff, inboxRouter);
  app.use("/api/today", staff, todayRouter);
  app.use("/api/leads", staff, leadActionsRouter);
  app.use("/api/leads", staff, leadsRouter);
  app.use("/api/messages", staff, messagesRouter);
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
  const bookingIds = (await prisma.booking.findMany({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { email: { startsWith: "zz-f3a-" } }] }, select: { id: true } })).map((b) => b.id);
  const leadIds = (await prisma.lead.findMany({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { contact: { contains: "zz-f3a-" } }] }, select: { id: true } })).map((l) => l.id);
  const requestIds = (await prisma.designRequest.findMany({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { email: { startsWith: "zz-f3a-" } }] }, select: { id: true } })).map((r) => r.id);
  const counts = {
    notifications: (await prisma.notification.deleteMany({ where: { accountId, OR: [{ body: { contains: ZZ } }, { bookingId: { in: bookingIds } }, { leadId: { in: leadIds } }] } })).count,
    messages: (await prisma.messageLog.deleteMany({ where: { accountId, OR: [{ bookingId: { in: bookingIds } }, { designRequestId: { in: requestIds } }, { leadId: { in: leadIds } }] } })).count,
    requests: (await prisma.designRequest.deleteMany({ where: { id: { in: requestIds } } })).count,
    bookings: (await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } })).count,
    leads: (await prisma.lead.deleteMany({ where: { id: { in: leadIds } } })).count,
    customers: (await prisma.customer.deleteMany({ where: { id: { in: made.customers } } })).count,
    items: (await prisma.item.deleteMany({ where: { id: { in: made.items } } })).count,
    policies: (await prisma.policyVersion.deleteMany({ where: { id: { in: made.policies } } })).count,
    statuses: (await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } }).catch(() => ({ count: -1 }))).count,
  };
  if (settingsBefore) await prisma.account.update({ where: { id: accountId }, data: settingsBefore as object });
  console.log("cleanup", JSON.stringify(counts), "remaining", JSON.stringify({ bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }), leads: await prisma.lead.count({ where: { customerName: { startsWith: ZZ } } }) }));
  await prisma.$disconnect();
});

test("the three actions: contact moves a new lead to Contacted once; not ready sets a date; lost needs a reason from the list", async () => {
  const l = await addLead();
  assert.equal(l.source, "phone");
  let row = await rowOf(l.id);
  assert.deepEqual([row.bucket, row.source, row.stage, row.nextAction.label], ["new", "Phone or in person", "New", "Contact them"]);

  assert.equal((await post(`/api/leads/${l.id}/contact`, { kind: "fax", note: "x" })).status, 400);
  const first = await post(`/api/leads/${l.id}/contact`, { kind: "call", note: "Left a voicemail https://evil.test" });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.movedTo, "Contacted", "the first contact moves it");
  row = await rowOf(l.id);
  assert.deepEqual([row.bucket, row.stage, row.nextAction.code], ["follow-up", "Contacted", "set-next-step"]);
  const second = await post(`/api/leads/${l.id}/contact`, { kind: "email", note: "Sent the quote" });
  assert.equal(second.json.movedTo, null, "a later contact does not move it again");
  const history = (await get(`/api/leads/${l.id}/activity`)).json as unknown as { kind: string | null; text: string; userName: string | null }[];
  assert.deepEqual(history.map((h) => h.kind).sort(), ["call", "email", "status"]);
  const callEntry = history.find((h) => h.kind === "call")!;
  assert.equal(callEntry.text.includes("http"), false, "links are stripped from the note");
  assert.equal(callEntry.userName, "ZZ Owner", "who logged it is kept");
  const stored = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
  assert.ok(stored.firstContactedAt && stored.lastContactedAt && stored.lastContactedAt >= stored.firstContactedAt);

  // Not ready: a date, not in the past.
  assert.equal((await post(`/api/leads/${l.id}/follow-up`, { date: day(-1), note: "x" })).json.reason, "date-past");
  assert.equal((await post(`/api/leads/${l.id}/follow-up`, { date: "soon" })).status, 400);
  const fu = await post(`/api/leads/${l.id}/follow-up`, { date: day(5), note: "Waiting on the venue" });
  assert.equal(fu.json.followUpOn, day(5));
  row = await rowOf(l.id);
  assert.deepEqual([row.nextAction.code, row.followUpOn], ["follow-up-later", day(5)]);
  // The day comes.
  await prisma.lead.update({ where: { id: l.id }, data: { followUpOn: new Date(`${day(0)}T00:00:00Z`) } });
  assert.equal((await rowOf(l.id)).nextAction.label, "Follow up today");
  const today = (await get("/api/today")).json as unknown as { columns: { key: string; count: number; groups: { key: string; items: { open: { id: string }; button: string }[] }[] }[] };
  assert.ok(today.columns.find((c) => c.key === "nurture")!.groups.find((g) => g.key === "follow-ups")!.items.some((i) => i.open.id === l.id), "it is on Today under Nurture");

  // Lost.
  assert.equal((await post(`/api/leads/${l.id}/lost`, {})).json.reason, "reason-required");
  assert.equal((await post(`/api/leads/${l.id}/lost`, { reason: "They were rude" })).json.reason, "reason-required", "the reason comes from the short list");
  const lost = await post(`/api/leads/${l.id}/lost`, { reason: "Price", note: "Went with a cheaper DJ" });
  assert.equal(lost.status, 200, JSON.stringify(lost.json));
  row = await rowOf(l.id);
  assert.deepEqual([row.bucket, row.stage, row.nextAction.label, row.followUpOn], ["lost", "Lost", "Closed: Price", null]);
  const back = await post(`/api/leads/${l.id}/reopen`, {});
  assert.equal(back.json.status, "Contacted");
  assert.equal((await rowOf(l.id)).bucket, "follow-up");
});

test("Send store link emails and texts the store address, logs it, and counts as the first contact", async () => {
  const l = await addLead();
  texts.length = 0;
  emails.length = 0;
  const r = await post(`/api/leads/${l.id}/store-link`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((r.json.sent as string[]).sort(), ["email", "text"]);
  assert.equal(r.json.movedTo, "Contacted");
  assert.ok(texts.some((t) => t.body.includes("https://store.test")), JSON.stringify(texts));
  assert.ok(emails.some((e) => e.body.includes("https://store.test") && e.body.includes(`Hi ${ZZ}`)));
  const logged = await prisma.messageLog.findMany({ where: { leadId: l.id, triggerKey: "lead_store_link" } });
  assert.deepEqual(logged.map((m) => [m.channel, m.status]).sort(), [["email", "sent"], ["sms", "sent"]], "every send is in the Sent log");
  assert.ok((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).storeLinkSentAt);
  // No way to reach them: said plainly, nothing sent.
  const bare = await addLead({ contact: "ask at the front desk" });
  const none = await post(`/api/leads/${bare.id}/store-link`, {});
  assert.equal(none.status, 409);
  assert.equal(none.json.reason, "no-contact");
});

test("a booking built from a lead links to it and moves it to Booked, with no second lead", async () => {
  const l = await addLead();
  const before = await leadCount();
  const r = await post("/api/bookings/staff", { leadId: l.id, customerName: `${ZZ} F3a Lead ${n}`, phone: "(860) 555-0590", email: `zz-f3a-${n}@example.test`, itemIds: [bar], eventDate: day(70), agreed: true, sendPayLink: false });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.leadId, l.id, "the booking hangs on the lead it was built from");
  assert.equal(await leadCount(), before, "no new lead was made");
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: r.json.bookingId as string } });
  assert.equal(b.leadId, l.id);
  assert.equal(b.origin, "staff");
  const row = await rowOf(l.id);
  assert.deepEqual([row.bucket, row.stage, row.bookingId, row.source, row.nextAction.label], ["booked", "Booked", b.id, "Phone or in person", "Waiting on the retainer"]);
  const stored = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
  assert.equal(stored.source, "phone", "the lead keeps where it came from");
  assert.equal(stored.occasion, "40th birthday", "and what was on it");
  const history = await prisma.leadActivity.findMany({ where: { leadId: l.id } });
  assert.ok(history.some((h) => /Built from this lead\. Moved to Booked\./.test(h.text)));
  const wrong = await post("/api/bookings/staff", { leadId: "not-a-lead", customerName: `${ZZ} F3a Nobody`, phone: "(860) 555-0591", email: "zz-f3a-nobody@example.test", itemIds: [bar], eventDate: day(71), agreed: true, sendPayLink: false });
  assert.equal(wrong.status, 404, JSON.stringify(wrong.json));
  assert.equal(wrong.json.reason, "lead-not-found");
});

test("a storefront booking with the same email or phone links to the open lead; a near match is noted, never linked", async () => {
  // A website lead, then the same person books in the store with that email.
  n += 1;
  const email = `zz-f3a-web-${n}@example.test`;
  const web = await prisma.lead.create({ data: { accountId, source: "website", status: "New", customerName: `${ZZ} F3a Web ${n}`, contact: `(860) 555-0600, ${email}` } });
  const before = await leadCount();
  const held = await post("/api/bookings/direct", { itemId: bar, eventDate: day(72), eventTime: "2 PM", customerName: `${ZZ} F3a Web ${n}`, phone: "(203) 555-0177", email: email.toUpperCase(), agreedToPolicy: true, delivery: null, tier: 1 });
  assert.equal(held.status, 201, JSON.stringify(held.json));
  assert.equal(await leadCount(), before, "the storefront booking made no new lead");
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: held.json.bookingId as string } });
  assert.equal(b.leadId, web.id);
  assert.equal(b.origin, "storefront");
  const row = await rowOf(web.id);
  assert.deepEqual([row.bucket, row.stage, row.source], ["booked", "Booked", "Website form"], "it moved to Booked and still says where it came from");
  assert.ok((await prisma.leadActivity.findMany({ where: { leadId: web.id } })).some((h) => /Linked to this lead because the email or phone is the same/.test(h.text)));
  const bell = await prisma.notification.findFirst({ where: { dedupeKey: `storefront-booking:${b.id}` } });
  assert.equal(bell?.title, "Storefront booking from an existing lead", "staff are still told a date was held");
  // It was made in the store, so the storefront hold still applies: nothing timed is sent while it is Held and unpaid.
  const plan = (await loadPlans({ bookingId: b.id }))[0].plan;
  assert.ok(plan.items.filter((i) => i.seriesId === "event").every((i) => i.state === "stopped"), "the hold reads where the booking was made, not the lead's source");
  assert.equal(plan.items.some((i) => i.seriesId === "hold_reminder"), false, "no account, so no unpaid hold email either");

  // The same phone, on a second lead: also linked.
  n += 1;
  const byPhone = await prisma.lead.create({ data: { accountId, source: "ask-go", status: "Contacted", customerName: `${ZZ} F3a Asker ${n}`, contact: "8605550611" } });
  const held2 = await post("/api/bookings/direct", { itemId: bar, eventDate: day(73), customerName: `${ZZ} Different Name`, phone: "+1 (860) 555-0611", email: `zz-f3a-other-${n}@example.test`, agreedToPolicy: true, delivery: null, tier: 1 });
  assert.equal(held2.status, 201, JSON.stringify(held2.json));
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: held2.json.bookingId as string } })).leadId, byPhone.id);

  // Near: the same name, other contact details. A new lead, and both are noted.
  n += 1;
  const near = await prisma.lead.create({ data: { accountId, source: "website", status: "New", customerName: `${ZZ} F3a Twin ${n}`, contact: "(860) 555-0622" } });
  const beforeNear = await leadCount();
  const held3 = await post("/api/bookings/direct", { itemId: bar, eventDate: day(74), customerName: `${ZZ} F3a Twin ${n}`, phone: "(203) 555-0633", email: `zz-f3a-twin-${n}@example.test`, agreedToPolicy: true, delivery: null, tier: 1 });
  assert.equal(held3.status, 201, JSON.stringify(held3.json));
  assert.equal(await leadCount(), beforeNear + 1, "a near match gets its own lead, as before");
  const b3 = await prisma.booking.findUniqueOrThrow({ where: { id: held3.json.bookingId as string } });
  assert.notEqual(b3.leadId, near.id);
  await settle(1500);
  assert.ok((await prisma.lead.findUniqueOrThrow({ where: { id: near.id } })).tags.includes("Possible duplicate"));
  assert.ok((await prisma.lead.findUniqueOrThrow({ where: { id: b3.leadId as string } })).tags.includes("Possible duplicate"));
  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: near.id } })).status, "New", "the near lead is not moved");
  const detail = (await get(`/api/leads/${near.id}/detail`)).json as unknown as { possibleMatches: { id: string }[] };
  assert.ok(detail.possibleMatches.some((m) => m.id === b3.leadId), "the popup shows the possible match");

  // A lead that is already Lost is not picked up again.
  n += 1;
  const lostEmail = `zz-f3a-lost-${n}@example.test`;
  const lost = await prisma.lead.create({ data: { accountId, source: "website", status: "Lost", customerName: `${ZZ} F3a Gone ${n}`, contact: lostEmail } });
  const held4 = await post("/api/bookings/direct", { itemId: bar, eventDate: day(75), customerName: `${ZZ} F3a Gone ${n}`, phone: "(203) 555-0644", email: lostEmail, agreedToPolicy: true, delivery: null, tier: 1 });
  assert.notEqual((await prisma.booking.findUniqueOrThrow({ where: { id: held4.json.bookingId as string } })).leadId, lost.id);
});

test("a storefront request is a row in the inbox, is counted, and its converted booking's lead reads as Storefront", async () => {
  n += 1;
  const signup = await post("/api/customer/signup", { name: `${ZZ} F3a Holder ${n}`, phone: "860-555-0701", email: `zz-f3a-holder-${n}@example.test`, password: "a-long-enough-password" });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  const customerId = (signup.json.customer as { id: string }).id;
  made.customers.push(customerId);
  await prisma.item.update({ where: { id: hall }, data: { price: 5000 } });
  const sent = await post("/api/bookings/direct", { itemId: hall, eventDate: day(80), occasion: "Holiday party", agreedToPolicy: true, delivery: null, address: null }, signup.cookie!);
  await prisma.item.update({ where: { id: hall }, data: { price: 2500 } });
  assert.equal(sent.status, 202, JSON.stringify(sent.json));
  const requestId = sent.json.designRequestId as string;
  let box = await inbox();
  const row = box.rows.find((r) => r.key === `request:${requestId}`)!;
  assert.deepEqual([row.kind, row.source, row.stage, row.nextAction.label, row.tabs.includes("requests")], ["request", "Storefront", "Storefront request", "Review it, then convert or dismiss", true]);
  const waiting = box.tabs.find((t) => t.key === "requests")!.count;
  assert.ok(waiting >= 1);
  assert.equal((await get(`/api/design-requests/${requestId}`)).json.id, requestId, "the popup can read one request");
  const today = (await get("/api/today")).json as unknown as { columns: { key: string; groups: { key: string; items: { open: { kind: string; id: string }; button: string }[] }[] }[] };
  assert.ok(today.columns[0].groups.find((g) => g.key === "requests")!.items.some((i) => i.open.kind === "request" && i.open.id === requestId && i.button === "Review"));

  const c = await post("/api/bookings/staff", { designRequestId: requestId, customerId, customerName: `${ZZ} F3a Holder ${n}`, itemIds: [hall], eventDate: day(80), occasion: "Holiday party", total: 800, agreed: true, sendPayLink: false });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  box = await inbox();
  assert.equal(box.tabs.find((t) => t.key === "requests")!.count, waiting - 1, "the count drops when it is converted");
  assert.equal(box.rows.some((r) => r.key === `request:${requestId}`), false);
  const leadRow = box.rows.find((r) => r.bookingId === c.json.bookingId)!;
  assert.deepEqual([leadRow.kind, leadRow.bucket, leadRow.source], ["lead", "booked", "Storefront"]);
  // Every tab's number is the number of rows in it.
  for (const t of box.tabs) assert.equal(t.count, box.rows.filter((r) => r.tabs.includes(t.key)).length, t.label);
  assert.equal(box.tabs.find((t) => t.key === "all")!.count, box.rows.length);
});

test("Send contract link and setting Contract Sent by hand both state the retainer amount", async () => {
  n += 1;
  const r = await post("/api/bookings/staff", { customerName: `${ZZ} F3a Contract ${n}`, phone: "(860) 555-0801", email: `zz-f3a-contract-${n}@example.test`, itemIds: [hall], eventDate: day(85), eventTime: "4 PM", agreed: true, sendPayLink: false });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.tier, 2);
  const id = r.json.bookingId as string;
  texts.length = 0;
  const sent = await post("/api/messages/send", { target: { bookingId: id }, kind: "contract-link" });
  assert.ok(sent.status < 300, JSON.stringify(sent.json));
  await settle();
  const logs = await prisma.messageLog.findMany({ where: { bookingId: id, status: "sent" } });
  assert.ok(logs.length > 0 && logs.every((l) => l.triggerKey === "contract_sent_pay"), JSON.stringify(logs.map((l) => l.triggerKey)));
  assert.ok(texts.some((t) => t.body.includes("$500.00") && t.body.includes("/sign/")), `the button's text states the retainer: ${JSON.stringify(texts)}`);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id } })).status, "Contract Sent");
});

test("a signed-in customer's unpaid hold gets the email reminder at 1 and 3 days; a guest's does not; the setting switches it off", async () => {
  n += 1;
  const signup = await post("/api/customer/signup", { name: `${ZZ} F3a Member ${n}`, phone: "860-555-0901", email: `zz-f3a-member-${n}@example.test`, password: "a-long-enough-password" });
  made.customers.push((signup.json.customer as { id: string }).id);
  const held = await post("/api/bookings/direct", { itemId: bar, eventDate: day(90), agreedToPolicy: true, delivery: null, tier: 1 }, signup.cookie!);
  assert.equal(held.status, 201, JSON.stringify(held.json));
  const id = held.json.bookingId as string;
  const mine = async () => (await loadPlans({ bookingId: id }))[0].plan.items.filter((i) => i.seriesId === "hold_reminder");
  let items = await mine();
  assert.deepEqual(items.map((i) => [i.triggerKey, i.channel]), [["hold_unpaid_reminder", "email"], ["hold_unpaid_reminder", "email"]], "two emails, no texts");
  const created = (await prisma.booking.findUniqueOrThrow({ where: { id } })).createdAt;
  assert.deepEqual(items.map((i) => Math.round((i.dueAt.getTime() - created.getTime()) / 86_400_000)), [1, 3]);
  assert.ok(items.every((i) => i.state === "scheduled"), JSON.stringify(items.map((i) => [i.state, i.reason])));
  const planned = (await loadPlans({ bookingId: id }))[0];
  assert.match(planned.send.context.extra?.payLink ?? "", /^https:\/\/api\.test\/pay\//);
  assert.equal(planned.send.context.extra?.amountDue, "$45.00");

  // The switch on Integrations: pay links in messages point at the store's page.
  await prisma.account.update({ where: { id: accountId }, data: { payLinksOpenStorefront: true } });
  assert.match((await loadPlans({ bookingId: id }))[0].send.context.extra?.payLink ?? "", /^https:\/\/store\.test\/pay\//);
  await prisma.account.update({ where: { id: accountId }, data: { payLinksOpenStorefront: false } });

  // Paid: they stop.
  await prisma.booking.update({ where: { id }, data: { retainerPaid: true } });
  assert.ok((await mine()).every((i) => i.state === "stopped"));
  await prisma.booking.update({ where: { id }, data: { retainerPaid: false } });
  // Switched off in Booking rules: none planned.
  await prisma.account.update({ where: { id: accountId }, data: { holdReminderEmails: false } });
  assert.equal((await mine()).length, 0);
  await prisma.account.update({ where: { id: accountId }, data: { holdReminderEmails: true } });
});
