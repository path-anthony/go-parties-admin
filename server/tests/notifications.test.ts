// Block A10, on a throwaway database: every producer fires once and not
// twice, the time checks pick the right bookings, the routes page and mark
// read behind the admin session, and the digest builds the right email
// through the real scheduler pass and skips when there is nothing to say.
// Twilio and the email webhook are stubbed. Every row made here is deleted.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.STOREFRONT_URL = "https://store.test";
process.env.PUBLIC_API_URL = "https://api.test";
process.env.EMAIL_WEBHOOK_URL = "https://email.test/hook";
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "https://store.test";
delete process.env.STRIPE_SECRET_KEY;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { runAsActor } from "../actor.js";
import { requireAuth } from "../auth.js";
import { runAutomation } from "../automation/runner.js";
import { addDays, atEastern, easternDay } from "../automation/time.js";
import { prisma } from "../db.js";
import { buildDigest, digestWindow, notifyDesignRequest, notifyNewLead, runTimedNotifications } from "../notifications.js";
import conciergeLeadsRouter from "../routes/conciergeLeads.js";
import directBookingsRouter, { staffBookingRouter } from "../routes/directBookings.js";
import externalLeadsRouter from "../routes/externalLeads.js";
import notificationsRouter from "../routes/notifications.js";
import { customerWriteGuard } from "../security.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("notifications.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
let accountId = "";
let policyId = "";
let madePolicy: string | null = null;
let itemId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let settingsBefore: Record<string, unknown> | null = null;
const made = { bookings: [] as string[], leads: [] as string[], statuses: [] as string[] };
const emails: { to: string; subject: string; body: string; purpose: string }[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
  if (url === process.env.EMAIL_WEBHOOK_URL) {
    emails.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }
  return realFetch(input, init);
}) as typeof fetch;

const DAY = 86_400_000;
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const dayFromNow = (n: number) => new Date(`${addDays(easternDay(NOW), n)}T00:00:00Z`);

type BookingOver = { eventIn?: number; status?: string; total?: number | null; retainerPaid?: boolean; balancePaid?: boolean; occasion?: string | null; contractStatus?: string | null; sentAgo?: number | null; signedAgo?: number | null; tier?: number | null };
let counter = 0;
async function mkBooking(o: BookingOver = {}): Promise<string> {
  counter += 1;
  const id = await prisma.$transaction(async (tx) => {
    const b = await tx.booking.create({ data: { accountId, eventDate: dayFromNow(o.eventIn ?? 90), customerName: `${ZZ} Customer ${counter}`, status: o.status ?? "Held", total: o.total === undefined ? null : o.total, retainerPaid: o.retainerPaid ?? false, balancePaid: o.balancePaid ?? false, occasion: o.occasion ?? null, tier: o.tier ?? null } });
    const a = await tx.agreement.create({ data: { accountId, bookingId: b.id, policyVersionId: policyId, checkboxChecked: true, contractStatus: o.contractStatus ?? null, contractSentAt: o.sentAgo === null || o.sentAgo === undefined ? null : daysAgo(o.sentAgo) } });
    if (o.signedAgo !== null && o.signedAgo !== undefined) {
      await tx.contractDocument.create({ data: { accountId, agreementId: a.id, policyVersionId: policyId, downloadToken: `zz-dl-${counter}-${Date.now()}`, text: "x", pdf: new Uint8Array([1]), sha256: "x", signedName: "ZZ", consentElectronic: true, agreedToTerms: true, signedAt: daysAgo(o.signedAgo) } });
    }
    return b.id;
  });
  made.bookings.push(id);
  return id;
}

async function clearBookings() {
  await prisma.booking.deleteMany({ where: { id: { in: made.bookings } } });
  made.bookings.length = 0;
}

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  settingsBefore = { balanceDueDays: a.balanceDueDays, depositPercentage: a.depositPercentage, tier1Collect: a.tier1Collect, digestEmail: a.digestEmail, digestEnabled: a.digestEnabled, directBookingDailyCap: a.directBookingDailyCap, requireCustomerAccount: a.requireCustomerAccount, balanceReminderWindowDays: a.balanceReminderWindowDays };
  await prisma.account.update({ where: { id: accountId }, data: { balanceDueDays: 30, depositPercentage: 20, tier1Collect: "retainer", digestEmail: "digest@example.test", digestEnabled: true, directBookingDailyCap: 1000, requireCustomerAccount: false, balanceReminderWindowDays: 7 } });
  if ((await prisma.leadStatus.count({ where: { accountId } })) === 0) made.statuses.push((await prisma.leadStatus.create({ data: { accountId, name: "New", position: 0 } })).id);
  const existingPolicy = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  const policy = existingPolicy ?? (await prisma.policyVersion.create({ data: { accountId, version: 1, text: `${ZZ} rental policy.` } }));
  policyId = policy.id;
  if (!existingPolicy) madePolicy = policy.id;
  itemId = (await prisma.item.create({ data: { accountId, name: `${ZZ} Cart`, category: "Games", price: 100, priceUnit: "per day", units: { create: [{ label: "1" }, { label: "2" }, { label: "3" }] } } })).id;

  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/bookings/direct", customerWriteGuard);
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/leads/external", externalLeadsRouter);
  app.use("/api/leads/concierge", conciergeLeadsRouter);
  app.use("/api/bookings/direct", directBookingsRouter);
  app.use("/api/bookings/staff", (_req, _res, next) => runAsActor({ id: "zz-owner", name: "ZZ Owner", role: "Owner" }, () => next()), staffBookingRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/gated", requireAuth, notificationsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { accountId } });
  emails.length = 0;
});

after(async () => {
  server?.close();
  globalThis.fetch = realFetch;
  const n = await prisma.notification.deleteMany({ where: { accountId } });
  const logs = await prisma.messageLog.deleteMany({ where: { OR: [{ bookingId: { in: made.bookings } }, { triggerKey: "staff_daily_digest" }, { recipient: { startsWith: "+1500555" } }] } });
  const b = await prisma.booking.deleteMany({ where: { OR: [{ id: { in: made.bookings } }, { customerName: { startsWith: ZZ } }] } });
  const l = await prisma.lead.deleteMany({ where: { OR: [{ id: { in: made.leads } }, { customerName: { startsWith: ZZ } }, { source: "concierge" }] } });
  await prisma.designRequest.deleteMany({ where: { customerName: { startsWith: ZZ } } });
  const i = await prisma.item.deleteMany({ where: { id: itemId } });
  const st = await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } });
  if (madePolicy) await prisma.policyVersion.delete({ where: { id: madePolicy } });
  if (settingsBefore) await prisma.account.update({ where: { id: accountId }, data: settingsBefore as object });
  const left = { notifications: await prisma.notification.count({ where: { accountId } }), bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }), leads: await prisma.lead.count({ where: { customerName: { startsWith: ZZ } } }) };
  console.log(`# cleanup: ${n.count} notifications, ${logs.count} message logs, ${b.count} bookings, ${l.count} leads, ${i.count} items, ${st.count} lead columns; remaining ${JSON.stringify(left)}`);
  await prisma.$disconnect();
});

const post = async (path: string, body: unknown) => {
  const r = await realFetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://store.test" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const get = async (path: string) => {
  const r = await realFetch(`${base}${path}`);
  return { status: r.status, json: (await r.json()) as { items: { id: string; title: string; readAt: string | null; type: string }[]; total: number; unread: number; page: number } };
};
const ofType = (type: string) => prisma.notification.findMany({ where: { accountId, type }, orderBy: { createdAt: "asc" } });

test("new-lead fires for the website, a concierge request and a storefront hold, once each; a staff booking does not", async () => {
  const w = await post("/api/leads/external", { customerName: `${ZZ} Web Lead`, contact: "+15005550401", occasion: "Birthday" });
  assert.equal(w.status, 201, JSON.stringify(w.json));
  made.leads.push(w.json.id as string);
  const c = await post("/api/leads/concierge", { source: "checkout", occasion: "Wedding" });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  made.leads.push(c.json.leadId as string);
  const h = await post("/api/bookings/direct", { itemId, eventDate: addDays(easternDay(NOW), 70), eventTime: "2 PM", customerName: `${ZZ} Hold`, phone: "+15005550402", email: "zz-a10@example.test", agreedToPolicy: true, delivery: null, address: "9 Event Rd, Avon, CT" });
  assert.equal(h.status, 201, JSON.stringify(h.json));
  made.bookings.push(h.json.bookingId as string);

  const rows = await ofType("new-lead");
  assert.equal(rows.length, 3);
  assert.match(rows[0].body, /ZZTEST Web Lead\. Website inquiry: Birthday\./);
  assert.equal(rows[0].link, `/leads?lead=${w.json.id}`);
  assert.match(rows[1].body, /^No name yet\. Concierge request: Wedding\./);
  assert.match(rows[2].body, /ZZTEST Hold\. Storefront booking/);
  assert.equal(rows[2].bookingId, h.json.bookingId);

  const s = await post("/api/bookings/staff", { itemIds: [itemId], eventDate: addDays(easternDay(NOW), 71), customerName: `${ZZ} Staff`, phone: "+15005550403", email: "zz-a10s@example.test", agreed: true });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  made.bookings.push(s.json.bookingId as string);
  assert.equal((await ofType("new-lead")).length, 3, "a booking staff made is not news");

  await notifyNewLead({ id: w.json.id as string, accountId, source: "website", customerName: `${ZZ} Web Lead` });
  assert.equal((await ofType("new-lead")).length, 3, "the same lead never fires twice");
});

test("design-request fires once when a tier 3 request is created, and holds nothing", async () => {
  const eventDate = addDays(easternDay(NOW), 120);
  const r = await post("/api/bookings/direct", { itemId, eventDate, eventTime: "5 PM", customerName: `${ZZ} Big Event`, phone: "+15005550404", email: "zz-a10b@example.test", agreedToPolicy: true, delivery: null, address: "9 Event Rd, Avon, CT", occasion: "Wedding" });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const rows = await ofType("design-request");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Big event request");
  assert.equal(rows[0].link, "/design-requests?status=Open");
  assert.equal(rows[0].bookingId, null, "no booking exists yet");
  assert.match(rows[0].body, /^ZZTEST Big Event, .*\. Wedding\. \$100\.$/);
  const request = await prisma.designRequest.findUniqueOrThrow({ where: { id: r.json.designRequestId as string } });
  await notifyDesignRequest(request);
  assert.equal((await ofType("design-request")).length, 1, "the same request never fires twice");
});

test("contract-unsigned-3d picks only live, unsigned, 3-day-old contracts on future events, and fires once", async () => {
  await clearBookings();
  const due = await mkBooking({ status: "Contract Sent", contractStatus: "Sent", sentAgo: 4 });
  const tier2 = await mkBooking({ status: "Held", contractStatus: "Sent", sentAgo: 3.5, tier: 2 });
  await mkBooking({ status: "Contract Sent", contractStatus: "Sent", sentAgo: 2 });
  await mkBooking({ status: "Signed", contractStatus: "Signed", sentAgo: 5, signedAgo: 1, retainerPaid: true });
  await mkBooking({ status: "Signed", contractStatus: "Sent", sentAgo: 5, retainerPaid: true }); // staff marked a paper contract signed
  await mkBooking({ status: "Cancelled", contractStatus: "Sent", sentAgo: 5 });
  await mkBooking({ status: "Released", contractStatus: "Sent", sentAgo: 5 });
  await mkBooking({ status: "Contract Sent", contractStatus: "Sent", sentAgo: 5, eventIn: -1 });
  await mkBooking({ status: "Held" });

  const first = await runTimedNotifications(NOW);
  const rows = await ofType("contract-unsigned-3d");
  assert.deepEqual(rows.map((r) => r.bookingId).sort(), [due, tier2].sort());
  assert.equal(rows[0].title, "Needs a push to sign");
  assert.match(rows[0].body, /Contract sent .*, not signed\./);
  assert.equal(first.created, 2);
  const second = await runTimedNotifications(NOW);
  assert.equal(second.created, 0, "the second pass adds nothing");
  assert.equal((await ofType("contract-unsigned-3d")).length, 2);
});

test("retainer-unpaid-3d picks signed bookings still unpaid after 3 days, and fires once", async () => {
  await clearBookings();
  const due = await mkBooking({ status: "Signed", contractStatus: "Signed", signedAgo: 4 });
  await mkBooking({ status: "Signed", contractStatus: "Signed", signedAgo: 2 });
  await mkBooking({ status: "Signed", contractStatus: "Signed", signedAgo: 5, retainerPaid: true });
  await mkBooking({ status: "Cancelled", contractStatus: "Signed", signedAgo: 5 });
  await mkBooking({ status: "Signed", contractStatus: "Signed", signedAgo: 5, eventIn: -2 });

  await runTimedNotifications(NOW);
  await runTimedNotifications(NOW);
  const rows = await ofType("retainer-unpaid-3d");
  assert.deepEqual(rows.map((r) => r.bookingId), [due]);
  assert.match(rows[0].body, /Signed .*, retainer not paid\./);
});

test("balance-due-7d picks balances due within 7 days or already overdue, skips the paid and the far off, and fires once", async () => {
  await clearBookings();
  // Balance is due 30 days before the event; retainer 20% of $1,000.
  const in5 = await mkBooking({ eventIn: 35, total: 1000, status: "Signed", retainerPaid: true });
  const overdue = await mkBooking({ eventIn: 20, total: 1000, status: "Signed", retainerPaid: true });
  await mkBooking({ eventIn: 60, total: 1000, status: "Signed", retainerPaid: true });
  await mkBooking({ eventIn: 35, total: 1000, status: "Signed", retainerPaid: true, balancePaid: true });
  await mkBooking({ eventIn: 35, total: null, status: "Signed" });
  await mkBooking({ eventIn: 35, total: 1000, status: "Cancelled" });
  await mkBooking({ eventIn: -1, total: 1000, status: "Signed", retainerPaid: true });

  await runTimedNotifications(NOW);
  await runTimedNotifications(NOW);
  const rows = await ofType("balance-due-7d");
  assert.deepEqual(rows.map((r) => r.bookingId).sort(), [in5, overdue].sort());
  const soon = rows.find((r) => r.bookingId === in5);
  assert.match(soon?.body ?? "", /\$1,000 due /, "retainer already paid but not recorded as money, so the whole total is open");
  assert.match(rows.find((r) => r.bookingId === overdue)?.body ?? "", / was due /);
  // Moving the event is a new due day, so it is raised again.
  await prisma.booking.update({ where: { id: in5 }, data: { eventDate: dayFromNow(34) } });
  await runTimedNotifications(NOW);
  assert.equal((await ofType("balance-due-7d")).length, 3);
});

test("balance-due alerts follow the balance reminder window setting, not a fixed 7 days", async () => {
  await clearBookings();
  // Balance is due 30 days before the event, so an event 40 days out has its balance due in 10 days.
  const due10 = await mkBooking({ eventIn: 40, total: 1000, status: "Signed", retainerPaid: true });
  await runTimedNotifications(NOW);
  assert.equal((await ofType("balance-due-7d")).filter((r) => r.bookingId === due10).length, 0, "10 days out is past a 7 day window");
  await prisma.account.update({ where: { id: accountId }, data: { balanceReminderWindowDays: 14 } });
  await runTimedNotifications(NOW);
  assert.equal((await ofType("balance-due-7d")).filter((r) => r.bookingId === due10).length, 1, "inside a 14 day window");
  await prisma.account.update({ where: { id: accountId }, data: { balanceReminderWindowDays: 7 } });
});

test("the routes page unread first, count unread, filter by type, mark one and all read, and need the admin session", async () => {
  const mk = (n: number, type: string, readAt: Date | null) => prisma.notification.create({ data: { accountId, type, title: `T${n}`, body: `B${n}`, link: "/leads", dedupeKey: `zz-route-${n}`, readAt, createdAt: new Date(NOW.getTime() - n * 60_000) } });
  const newestRead = await mk(1, "new-lead", new Date());
  const unreadOld = await mk(3, "balance-due-7d", null);
  const unreadNew = await mk(2, "new-lead", null);
  void newestRead;

  let r = await get("/api/notifications");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((i) => i.title), ["T2", "T3", "T1"], "unread first, newest first within");
  assert.equal(r.json.unread, 2);
  assert.equal(r.json.total, 3);

  r = await get("/api/notifications?limit=2&page=2");
  assert.deepEqual(r.json.items.map((i) => i.title), ["T1"]);
  r = await get("/api/notifications?type=balance-due-7d");
  assert.deepEqual(r.json.items.map((i) => i.title), ["T3"]);
  assert.equal(r.json.unread, 2, "the count is the whole bell, not the filter");
  assert.equal((await get("/api/notifications?type=nope")).status, 400);
  assert.equal((await get("/api/notifications?limit=0")).status, 400);

  assert.equal((await post(`/api/notifications/${unreadNew.id}/read`, {})).status, 200);
  const firstRead = (await prisma.notification.findUniqueOrThrow({ where: { id: unreadNew.id } })).readAt;
  assert.ok(firstRead);
  await post(`/api/notifications/${unreadNew.id}/read`, {});
  assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: unreadNew.id } })).readAt?.getTime(), firstRead.getTime(), "reading twice keeps the first time");
  assert.equal((await get("/api/notifications")).json.unread, 1);
  assert.equal((await post("/api/notifications/nope/read", {})).status, 404);

  const all = await post("/api/notifications/read-all", {});
  assert.equal(all.json.marked, 1);
  assert.equal((await get("/api/notifications")).json.unread, 0);
  assert.ok((await prisma.notification.findUniqueOrThrow({ where: { id: unreadOld.id } })).readAt);

  assert.equal((await get("/api/gated")).status, 401, "no session, no list");
  assert.equal((await post("/api/gated/read-all", {})).status, 401);
});

test("buildDigest groups by type in order, with absolute links", () => {
  const d = buildDigest([{ type: "balance-due-7d", body: "Ann, Sat. $800 due Mon.", link: "/b1" }, { type: "new-lead", body: "Bo. Website inquiry.", link: "/l1" }, { type: "new-lead", body: "Cy. Website inquiry.", link: "/l2" }], "https://admin.test");
  assert.equal(d.count, 3);
  assert.equal(d.body, "New leads (2)\n- Bo. Website inquiry.\n  https://admin.test/l1\n- Cy. Website inquiry.\n  https://admin.test/l2\n\nBalance due soon (1)\n- Ann, Sat. $800 due Mon.\n  https://admin.test/b1");
  const many = buildDigest(Array.from({ length: 30 }, (_, i) => ({ type: "new-lead", body: `L${i}`, link: "/x" })), "");
  assert.match(many.body, /and 5 more$/);
  assert.equal(many.count, 30);
});

// A future day, so the scheduler's start date never gets in the way.
const digestDay = (n: number) => addDays(easternDay(NOW), n);
const inWindow = (day: string, n: number, over: { readAt?: Date | null; type?: string; body?: string } = {}) => prisma.notification.create({ data: { accountId, type: over.type ?? "new-lead", title: "New lead", body: over.body ?? `Lead ${n}.`, link: `/leads?lead=${n}`, dedupeKey: `zz-digest-${day}-${n}`, readAt: over.readAt ?? null, createdAt: new Date(digestWindow(day).start.getTime() + 3_600_000 * n) } });
const digests = () => emails.filter((e) => e.purpose === "staff_daily_digest");

test("the digest goes once, at the first pass from 7 AM, to the digest email, with only what is unread in the window", async () => {
  await clearBookings();
  const day = digestDay(2);
  await inWindow(day, 1, { body: "Ann. Website inquiry." });
  await inWindow(day, 2, { type: "balance-due-7d", body: "Bo, Sat. $800 due Mon." });
  await inWindow(day, 3, { readAt: new Date(), body: "Already read." });
  // Before the window, and after it.
  await prisma.notification.create({ data: { accountId, type: "new-lead", title: "Old", body: "Too old.", link: "/x", dedupeKey: `zz-old-${day}`, createdAt: new Date(digestWindow(day).start.getTime() - 60_000) } });
  await prisma.notification.create({ data: { accountId, type: "new-lead", title: "Late", body: "After seven.", link: "/x", dedupeKey: `zz-late-${day}`, createdAt: new Date(digestWindow(day).end.getTime() + 60_000) } });

  await runAutomation({ dryRun: false, source: "admin", now: atEastern(day, 6, 30) });
  assert.equal(digests().length, 0, "not before 7");
  const dry = await runAutomation({ dryRun: true, source: "admin", now: atEastern(day, 7, 30) });
  assert.equal(digests().length, 0, "a dry run sends nothing");
  assert.ok(dry.lines.some((l) => l.trigger === "staff_daily_digest" && l.result === "would send"));

  await runAutomation({ dryRun: false, source: "admin", now: atEastern(day, 7, 30) });
  assert.equal(digests().length, 1);
  const mail = digests()[0];
  assert.equal(mail.to, "digest@example.test");
  assert.equal(mail.subject, "GO admin: 2 unread");
  assert.match(mail.body, /New leads \(1\)\n- Ann\. Website inquiry\.\n {2}https:\/\/api\.test\/leads\?lead=1/);
  assert.match(mail.body, /Balance due soon \(1\)\n- Bo, Sat\. \$800 due Mon\./);
  assert.match(mail.body, /See them all: https:\/\/api\.test\/notifications/);
  for (const absent of ["Already read", "Too old", "After seven"]) assert.doesNotMatch(mail.body, new RegExp(absent));

  await runAutomation({ dryRun: false, source: "admin", now: atEastern(day, 8, 30) });
  assert.equal(digests().length, 1, "once a day");
  assert.equal(await prisma.messageLog.count({ where: { triggerKey: "staff_daily_digest", idempotencyKey: `staff_daily_digest:${day}:email` } }), 1);
});

test("the digest skips when nothing is unread or it is switched off, and a late pass still catches up", async () => {
  await clearBookings();
  const quiet = digestDay(3);
  await inWindow(quiet, 1, { readAt: new Date() });
  await runAutomation({ dryRun: false, source: "admin", now: atEastern(quiet, 7, 5) });
  assert.equal(digests().length, 0, "nothing unread, nothing sent");

  const off = digestDay(4);
  await inWindow(off, 1);
  await prisma.account.update({ where: { id: accountId }, data: { digestEnabled: false } });
  await runAutomation({ dryRun: false, source: "admin", now: atEastern(off, 7, 5) });
  assert.equal(digests().length, 0, "switched off");
  await prisma.account.update({ where: { id: accountId }, data: { digestEnabled: true } });

  const late = digestDay(5);
  await inWindow(late, 1);
  await runAutomation({ dryRun: false, source: "admin", now: atEastern(late, 11, 40) });
  assert.equal(digests().length, 1, "the 7 o'clock pass was missed; the next one sends it");
});
