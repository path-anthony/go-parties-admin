// Block F1, the money path, over HTTP on a throwaway database: paid means
// Confirmed on the policy and the contract path, the pay link and its
// automatic sends, the retainer reminders, the same Stripe event twice,
// cancellation requests (terms, Approve, Decline) and the refund log.
// Stripe, Twilio and the email webhook are stubbed; nothing here calls out.
// Every row made here is deleted at the end with counts.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.STOREFRONT_URL = "https://store.test";
process.env.PUBLIC_API_URL = "https://api.test";
process.env.EMAIL_WEBHOOK_URL = "http://stub.invalid/hook";
process.env.STRIPE_SECRET_KEY = "sk_test_zz";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_zz_test";
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "https://store.test";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { runAsActor } from "../actor.js";
import { loadPlans } from "../automation/loaders.js";
import { runAutomation } from "../automation/runner.js";
import { addDays, atEastern, easternDay } from "../automation/time.js";
import { prisma } from "../db.js";
import { findDueNotifications } from "../notifications.js";
import { markOptedOut } from "../optOuts.js";
import { settlePayment } from "../payments.js";
import { customerWriteGuard } from "../security.js";
import { setStripeFetch, signWebhookPayload } from "../stripe/client.js";
import customerRouter from "../routes/customer.js";
import directBookingsRouter, { staffBookingRouter } from "../routes/directBookings.js";
import { bookingMoneyRouter, cancellationRequestsRouter, moneyRouter } from "../routes/money.js";
import { payApiRouter, payPagesRouter } from "../routes/pay.js";
import { adminPaymentsRouter, publicPaymentsRouter } from "../routes/payments.js";
import stripeWebhookRouter from "../routes/stripeWebhook.js";
import tierRouter from "../routes/tier.js";
import { displayStatus } from "../../src/lib/bookingStatus.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("f1Money.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const made = { items: [] as string[], customers: [] as string[], bookings: [] as string[], requests: [] as string[], policies: [] as string[], statuses: [] as string[], events: [] as string[] };
let settingsBefore: Record<string, unknown> | null = null;
let bar = "";
let hall = "";

// ---- stubs: Twilio, the email webhook, Stripe ---------------------------------------
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

type Sess = { id: string; client_secret: string | null; url: string | null; status: string; payment_status: string; payment_intent: string; customer: string | null; amount_total: number; metadata: Record<string, string> };
const sessions = new Map<string, Sess>();
let sessionCount = 0;
const stripeCalls: { method: string; path: string; body: string }[] = [];
setStripeFetch((url, init) => {
  const path = url.replace("https://api.stripe.com", "");
  const body = typeof init?.body === "string" ? init.body : "";
  stripeCalls.push({ method: init?.method ?? "GET", path, body });
  const json = (status: number, data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (path === "/v1/customers") return json(200, { id: "cus_zz" });
  if (path === "/v1/checkout/sessions" && init?.method === "POST") {
    const p = new URLSearchParams(body);
    sessionCount += 1;
    const id = `cs_test_f1zz${sessionCount}`;
    const hosted = p.get("success_url") !== null;
    const s: Sess = { id, client_secret: hosted ? null : `${id}_secret_abc`, url: hosted ? `https://checkout.stripe.test/c/${id}` : null, status: "open", payment_status: "unpaid", payment_intent: `pi_f1zz${sessionCount}`, customer: p.get("customer"), amount_total: Number(p.get("line_items[0][price_data][unit_amount]")), metadata: { bookingId: p.get("metadata[bookingId]") ?? "", kind: p.get("metadata[kind]") ?? "" } };
    sessions.set(s.id, s);
    return json(200, s);
  }
  const m = /^\/v1\/checkout\/sessions\/([^/?]+)(\/expire)?/.exec(path);
  if (m) {
    const s = sessions.get(m[1]);
    if (!s) return json(404, { error: { message: "No such session" } });
    if (m[2]) s.status = "expired";
    return json(200, s);
  }
  return json(400, { error: { message: `unmocked ${path}` } });
});

// ---- helpers ------------------------------------------------------------------------
type Res = { status: number; json: Record<string, unknown>; cookie: string | null; location: string | null; text: string };
let ipCount = 0;
async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res> {
  ipCount += 1;
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://store.test", "X-Forwarded-For": `10.9.${Math.floor(ipCount / 200)}.${ipCount % 200}` };
  if (init.cookie) headers.Cookie = init.cookie;
  const r = await realFetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
  const set = r.headers.get("set-cookie");
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: r.status, json, cookie: set ? set.split(";")[0] : null, location: r.headers.get("location"), text };
}
const post = (path: string, body: unknown, cookie?: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const get = (path: string, cookie?: string) => call(path, { cookie });
const day = (n: number) => addDays(new Date().toISOString().slice(0, 10), n);
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const track = (r: Res) => {
  if (typeof r.json.bookingId === "string") made.bookings.push(r.json.bookingId);
  if (typeof r.json.designRequestId === "string") made.requests.push(r.json.designRequestId);
  return r;
};
let signups = 0;
async function signUp(over: Record<string, unknown> = {}) {
  signups += 1;
  const r = await post("/api/customer/signup", { name: `${ZZ} F1 Holder ${signups}`, phone: `860-555-03${String(signups).padStart(2, "0")}`, email: `zz-f1-holder-${signups}@example.test`, password: "a-long-enough-password", ...over });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  made.customers.push((r.json.customer as { id: string }).id);
  return { cookie: r.cookie!, customerId: (r.json.customer as { id: string }).id };
}
// A storefront hold of the $225 bar (policy path) by a signed-in customer.
async function storefrontHold(cookie: string, over: Record<string, unknown> = {}) {
  n += 1;
  const r = track(await post("/api/bookings/direct", { itemId: bar, eventDate: day(70 + n), eventTime: "2 PM", agreedToPolicy: true, delivery: null, tier: 1, ...over }, cookie));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r;
}
// A small rental staff book by phone: $225, so a $45 retainer at 20%.
async function staffSmall(over: Record<string, unknown> = {}) {
  n += 1;
  const r = track(await post("/api/bookings/staff", { customerName: `${ZZ} F1 Phone ${n}`, phone: `(860) 555-04${String(n).padStart(2, "0")}`, email: `zz-f1-phone-${n}@example.test`, itemIds: [bar], eventDate: day(70 + n), eventTime: "2 PM", agreed: true, ...over }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r;
}
async function webhook(event: Record<string, unknown>) {
  const raw = JSON.stringify(event);
  if (typeof event.id === "string") made.events.push(event.id);
  const r = await realFetch(`${base}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": signWebhookPayload(raw, process.env.STRIPE_WEBHOOK_SECRET as string, new Date()) }, body: raw });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
async function paidEvent(sessionId: string, id = `evt_f1zz_${sessionId}`) {
  const s = sessions.get(sessionId) as Sess;
  s.status = "complete";
  s.payment_status = "paid";
  return webhook({ id, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { id: s.id, payment_status: "paid", payment_intent: s.payment_intent, metadata: s.metadata } } });
}
const shown = async (id: string) => displayStatus(await prisma.booking.findUniqueOrThrow({ where: { id } }));
const unitsHeld = (id: string) => prisma.bookingUnit.count({ where: { bookingId: id } });
const logs = (bookingId: string, triggerKey: string) => prisma.messageLog.findMany({ where: { bookingId, triggerKey }, orderBy: { createdAt: "asc" } });

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  settingsBefore = { reviewAmountKids: a.reviewAmountKids, reviewAmountAdult: a.reviewAmountAdult, reviewAmountWedding: a.reviewAmountWedding, reviewAmountCorporate: a.reviewAmountCorporate, reviewAmountDefault: a.reviewAmountDefault, contractRequiredOver: a.contractRequiredOver, contractRequiredForCrewed: a.contractRequiredForCrewed, requireAgreementCheckbox: a.requireAgreementCheckbox, requireCustomerAccount: a.requireCustomerAccount, directBookingDailyCap: a.directBookingDailyCap, requireBotCheck: a.requireBotCheck, depositPercentage: a.depositPercentage, tier1Collect: a.tier1Collect, authorizedSignerName: a.authorizedSignerName, authorizedSignerTitle: a.authorizedSignerTitle, retainerReminderDay1: a.retainerReminderDay1, retainerReminderDay2: a.retainerReminderDay2, retainerReminderDay3: a.retainerReminderDay3, automationStartedAt: a.automationStartedAt, digestEnabled: a.digestEnabled };
  await prisma.account.update({ where: { id: accountId }, data: { reviewAmountKids: 10000, reviewAmountAdult: 10000, reviewAmountWedding: 5000, reviewAmountCorporate: 5000, reviewAmountDefault: 10000, contractRequiredOver: 1000, contractRequiredForCrewed: true, requireAgreementCheckbox: false, requireCustomerAccount: false, directBookingDailyCap: 1000, requireBotCheck: false, depositPercentage: 20, tier1Collect: "retainer", authorizedSignerName: "Mel Owner", authorizedSignerTitle: "Owner", retainerReminderDay1: 1, retainerReminderDay2: 3, retainerReminderDay3: 7, automationStartedAt: new Date(Date.now() - 86_400_000), digestEnabled: false } });
  await prisma.customer.deleteMany({ where: { accountId, email: { startsWith: "zz-f1-" } } });
  if ((await prisma.leadStatus.count({ where: { accountId } })) === 0) made.statuses.push((await prisma.leadStatus.create({ data: { accountId, name: "New", position: 0 } })).id);
  const policy = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  if (!policy || policy.text.trim() === "") made.policies.push((await prisma.policyVersion.create({ data: { accountId, version: (policy?.version ?? 0) + 1, text: `${ZZ} rental policy: the retainer is 20% and non-refundable.` } })).id);
  const mk = async (name: string, category: string, price: number) => {
    const item = await prisma.item.create({ data: { accountId, name: `${ZZ} F1 ${name}`, category, price, units: { create: Array.from({ length: 30 }, (_, i) => ({ label: String(i + 1) })) } } });
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
  app.use("/api/bookings/tier", customerWriteGuard);
  app.use("/api/webhooks/stripe", express.raw({ type: "*/*", limit: "1mb" }));
  app.use(express.json({ limit: "64kb" }));
  const staff = (_req: express.Request, _res: express.Response, next: express.NextFunction) => runAsActor({ id: "zz-owner", name: "ZZ Owner", role: "Owner" }, () => next());
  app.use("/api/webhooks/stripe", stripeWebhookRouter);
  app.use("/api/payments", publicPaymentsRouter);
  app.use("/pay", payPagesRouter);
  app.use("/api/pay", payApiRouter);
  app.use("/api/customer", customerRouter);
  app.use("/api/bookings/direct", directBookingsRouter);
  app.use("/api/bookings/tier", tierRouter);
  app.use("/api/bookings/staff", staff, staffBookingRouter);
  app.use("/api/bookings", staff, adminPaymentsRouter);
  app.use("/api/bookings", staff, bookingMoneyRouter);
  app.use("/api/cancellation-requests", staff, cancellationRequestsRouter);
  app.use("/api/money", staff, moneyRouter);
  app.use(((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.log("[test] route threw:", err instanceof Error ? err.stack : String(err));
    res.status(500).json({ error: "test: route threw" });
  }) as express.ErrorRequestHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await settle(300);
  globalThis.fetch = realFetch;
  setStripeFetch(null);
  const bookingIds = (await prisma.booking.findMany({ where: { accountId, customerName: { startsWith: ZZ } }, select: { id: true } })).map((b) => b.id);
  const requestIds = (await prisma.designRequest.findMany({ where: { accountId, customerName: { startsWith: ZZ } }, select: { id: true } })).map((r) => r.id);
  const counts = {
    notifications: (await prisma.notification.deleteMany({ where: { accountId, OR: [{ body: { contains: ZZ } }, { bookingId: { in: bookingIds } }] } })).count,
    messages: (await prisma.messageLog.deleteMany({ where: { accountId, OR: [{ bookingId: { in: bookingIds } }, { designRequestId: { in: requestIds } }] } })).count,
    stripeEvents: (await prisma.stripeEvent.deleteMany({ where: { id: { in: made.events } } })).count,
    requests: (await prisma.designRequest.deleteMany({ where: { id: { in: requestIds } } })).count,
    quotes: (await prisma.quote.deleteMany({ where: { accountId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } })).count,
    bookings: (await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } })).count,
    leads: (await prisma.lead.deleteMany({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { contact: { contains: "zz-f1-" } }] } })).count,
    customers: (await prisma.customer.deleteMany({ where: { id: { in: made.customers } } })).count,
    items: (await prisma.item.deleteMany({ where: { id: { in: made.items } } })).count,
    policies: (await prisma.policyVersion.deleteMany({ where: { id: { in: made.policies } } })).count,
    statuses: (await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } })).count,
  };
  if (settingsBefore) await prisma.account.update({ where: { id: accountId }, data: settingsBefore as object });
  const left = { bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }), cancellationRequests: await prisma.cancellationRequest.count({ where: { bookingId: { in: bookingIds } } }), refundRecords: await prisma.refundRecord.count({ where: { bookingId: { in: bookingIds } } }) };
  console.log("cleanup", JSON.stringify(counts), "remaining", JSON.stringify(left));
  await prisma.$disconnect();
});

// ---- 1. paid means Confirmed --------------------------------------------------------
test("a paid policy booking becomes Confirmed, the customer and staff are told, and its reminders run", async () => {
  const { cookie } = await signUp();
  const r = await storefrontHold(cookie, { occasion: "Rehearsal dinner" });
  const id = r.json.bookingId as string;
  const pay = r.json.payment as { sessionId: string; amount: number };
  assert.equal(pay.amount, 45, "20% of $225");
  assert.equal(await shown(id), "Held");

  // Before it is paid the storefront hold pauses everything timed.
  let plan = (await loadPlans({ bookingId: id }))[0].plan;
  assert.ok(plan.items.filter((i) => i.seriesId === "event").every((i) => i.state === "stopped"), "event reminders are held back before payment");

  const ok = await paidEvent(pay.sessionId);
  assert.deepEqual(ok.json, { received: true, duplicate: false, handled: true });
  await settle();
  const b = await prisma.booking.findUniqueOrThrow({ where: { id } });
  assert.equal(b.retainerPaid, true);
  assert.equal(b.status, "Held", "the stored stage is untouched");
  assert.ok(b.confirmedAt, "the moment it was confirmed is stored");
  assert.equal(displayStatus(b), "Confirmed");
  const mine = await get("/api/customer/bookings", cookie);
  assert.equal((mine.json as unknown as { id: string; stage: string }[]).find((x) => x.id === id)?.stage, "Confirmed", "the customer reads Confirmed");

  assert.equal((await logs(id, "booking_confirmed")).filter((l) => l.status === "sent").length >= 1, true, "the customer is told it is confirmed");
  assert.equal((await logs(id, "retainer_paid")).length, 0, "and is not told to sign a contract that does not exist");
  const bell = await prisma.notification.findMany({ where: { bookingId: id, type: "payment-received" } });
  assert.equal(bell.length, 1, "staff get one Payment received alert");
  assert.match(bell[0].body, /\$45 retainer, by card/);

  // Now the reminders run: nothing is held back by the storefront hold.
  plan = (await loadPlans({ bookingId: id }))[0].plan;
  const event = plan.items.filter((i) => i.seriesId === "event");
  // (This test hold has no address, so the ones that print it wait on that; the point is the hold no longer stops them.)
  assert.ok(event.length > 0 && event.every((i) => i.state !== "stopped"), `event reminders are no longer stopped: ${JSON.stringify(event.map((i) => [i.triggerKey, i.state, i.reason]))}`);
  assert.ok(event.some((i) => i.state === "scheduled"));
  const wedding = plan.items.filter((i) => i.seriesId === "wedding_details");
  assert.ok(wedding.every((i) => i.state !== "stopped"), "wedding details reminders are no longer stopped by the hold");
});

test("staff recording the retainer by hand, or ticking it paid, confirms a policy booking the same way", async () => {
  const r = await staffSmall({ sendPayLink: false });
  const id = r.json.bookingId as string;
  const rec = await post(`/api/bookings/${id}/payments`, { kind: "retainer", amountCents: 4500, method: "check", note: "Check 1042" });
  assert.equal(rec.status, 201, JSON.stringify(rec.json));
  await settle();
  assert.equal(await shown(id), "Confirmed");
  const bell = await prisma.notification.findMany({ where: { bookingId: id, type: "payment-received" } });
  assert.equal(bell.length, 1);
  assert.match(bell[0].body, /by check, recorded by staff/);
});

test("a signed and paid contract booking becomes Confirmed; signed alone is not", async () => {
  const { cookie } = await signUp();
  n += 1;
  const eventDate = day(70 + n);
  const t = await post("/api/bookings/tier", { itemId: hall, eventDate, eventTime: "2 PM" }, cookie);
  assert.equal(t.json.tier, 2, JSON.stringify(t.json));
  const q = t.json.contract as { quoteId: string; contentHash: string };
  const held = track(await post("/api/bookings/direct", { itemId: hall, eventDate, eventTime: "2 PM", agreedToPolicy: true, delivery: null, tier: 2, signature: { fullName: "Jordan Sample", esignConsent: true, contentHash: q.contentHash, quoteId: q.quoteId } }, cookie));
  assert.equal(held.status, 201, JSON.stringify(held.json));
  const id = held.json.bookingId as string;
  const pay = held.json.payment as { sessionId: string; amount: number };
  assert.equal(pay.amount, 500, "20% of the $2,500 contract");
  await settle(300);
  let b = await prisma.booking.findUniqueOrThrow({ where: { id } });
  assert.equal(displayStatus(b), "Signed", "signed, not paid: not Confirmed");
  assert.ok(b.retainerRequestedAt, "the retainer was asked for at checkout, so reminders will follow");
  assert.equal((await logs(id, "retainer_requested")).length, 0, "nothing is sent while they are on the pay screen");

  await paidEvent(pay.sessionId);
  await settle();
  b = await prisma.booking.findUniqueOrThrow({ where: { id } });
  assert.equal(displayStatus(b), "Confirmed");
  assert.ok((await logs(id, "booking_confirmed")).some((l) => l.status === "sent"));
});

// ---- 2 to 4. the pay link and its sends -----------------------------------------------
let phoneBooking = "";
test("staff create a small booking: the pay link goes by text and email with the amount, and the link opens Stripe's page", async () => {
  texts.length = 0;
  emails.length = 0;
  const r = await staffSmall();
  phoneBooking = r.json.bookingId as string;
  assert.deepEqual(r.json.payLink, { sent: true, step: "retainer", amountCents: 4500, why: null });
  const sent = await logs(phoneBooking, "retainer_requested");
  assert.deepEqual(sent.map((l) => [l.channel, l.status]).sort(), [["email", "sent"], ["sms", "sent"]], "every send is in the Sent log");
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: phoneBooking } });
  assert.ok(b.payToken && b.payToken.length >= 40, "the booking has a private token");
  const link = `https://api.test/pay/${b.payToken}`;
  assert.ok(texts.some((t) => t.body.includes("$45.00") && t.body.includes(link)), `the text states the amount and carries the link: ${JSON.stringify(texts)}`);
  assert.ok(emails.some((e) => e.body.includes("$45.00") && e.body.includes(link)));
  assert.ok(b.retainerRequestedAt && b.payLinkSentAt);
  assert.equal(b.payLinkSentByName, "Sent automatically");

  // The link, with no account and no cookie.
  const before = sessionCount;
  const open = await get(`/pay/${b.payToken}`);
  assert.equal(open.status, 303);
  assert.match(open.location ?? "", /^https:\/\/checkout\.stripe\.test\/c\/cs_test_f1zz/);
  const created = stripeCalls.filter((c) => c.path === "/v1/checkout/sessions" && c.method === "POST").at(-1)!;
  assert.ok(created.body.includes(`${encodeURIComponent("line_items[0][price_data][unit_amount]")}=4500`), "the amount is the server's");
  assert.ok(created.body.includes("success_url=") && !created.body.includes("ui_mode=embedded"), "a hosted Stripe page");
  // Opened again (the email, then the text): the same page, not a new one.
  const again = await get(`/pay/${b.payToken}`);
  assert.equal(again.location, open.location);
  assert.equal(sessionCount, before + 1, "a second open does not close the page the customer is on");
  assert.equal((await get("/pay/not-a-real-token-not-a-real-token-xyz")).status, 404);

  const json = await get(`/api/pay/${b.payToken}`);
  assert.equal(json.json.step, "retainer");
  assert.equal(json.json.amount, 45);
  assert.equal((json.json.policy as { text: string }).text.length > 0, true, "the policy text comes with it for the store to show");
  for (const hidden of ["phone", "email", "customerName", "notes", "leadId"]) assert.equal(hidden in json.json, false, `${hidden} is not in the public answer`);

  // The button: the amount is shown before sending, and it records when and who.
  const view = await get(`/api/bookings/${phoneBooking}/pay-link`);
  assert.equal(view.json.step, "retainer");
  assert.equal(view.json.amountCents, 4500);
  assert.equal(view.json.canSend, true);
  const manual = await post(`/api/bookings/${phoneBooking}/pay-link/send`, {});
  assert.equal(manual.status, 200, JSON.stringify(manual.json));
  assert.equal(manual.json.sent, true);
  assert.equal(manual.json.lastSentByName, "ZZ Owner");
  assert.equal((await logs(phoneBooking, "retainer_requested")).filter((l) => l.status === "sent").length, 4, "a hand-pressed send always goes, and is logged");
});

test("a converted policy request triggers the pay link send", async () => {
  const { cookie, customerId } = await signUp();
  n += 1;
  const eventDate = day(70 + n);
  // $5,000 for a corporate occasion goes to review; staff book it at $800.
  await prisma.item.update({ where: { id: hall }, data: { price: 5000 } });
  const r = track(await post("/api/bookings/direct", { itemId: hall, eventDate, occasion: "Holiday party", agreedToPolicy: true, delivery: null, address: null }, cookie));
  await prisma.item.update({ where: { id: hall }, data: { price: 2500 } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  texts.length = 0;
  const c = track(await post("/api/bookings/staff", { designRequestId: r.json.designRequestId, customerId, customerName: `${ZZ} F1 Holder`, itemIds: [hall], eventDate, occasion: "Holiday party", total: 800, agreed: true }));
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(c.json.tier, 1);
  const id = c.json.bookingId as string;
  assert.deepEqual(c.json.payLink, { sent: true, step: "retainer", amountCents: 16000, why: null });
  const sent = await logs(id, "retainer_requested");
  assert.ok(sent.some((l) => l.channel === "sms" && l.status === "sent") && sent.some((l) => l.channel === "email" && l.status === "sent"));
  assert.ok(texts.some((t) => t.body.includes("$160.00") && t.body.includes("https://api.test/pay/")));
  assert.equal((await logs(id, "contract_sent")).length + (await logs(id, "contract_sent_pay")).length, 0, "no contract on the policy path");
});

test("a contract booking made by staff gets the contract with the retainer amount; signing it unpaid sends the pay link", async () => {
  const { cookie, customerId } = await signUp({ homeAddress: "14 Maple Ln, Avon, CT 06001, USA" });
  n += 1;
  const eventDate = day(70 + n);
  texts.length = 0;
  const c = track(await post("/api/bookings/staff", { customerId, customerName: `${ZZ} F1 Holder`, itemIds: [hall], eventDate, eventTime: "4 PM", address: "14 Maple Ln, Avon, CT 06001, USA", guestCount: 80, occasion: "Birthday", agreed: true }));
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(c.json.tier, 2);
  const id = c.json.bookingId as string;
  const pl = c.json.payLink as { sent: boolean; step: string; amountCents: number; why: string | null };
  assert.equal(pl.step, "sign");
  assert.equal(pl.amountCents, 50000);
  assert.equal(pl.sent, true, `the contract went: ${pl.why}`);
  const contract = await logs(id, "contract_sent_pay");
  assert.ok(contract.some((l) => l.status === "sent"), "the contract message states the retainer");
  assert.ok(texts.some((t) => t.body.includes("$500.00") && t.body.includes("/contract")), JSON.stringify(texts));
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id } })).status, "Contract Sent", "it counted as sending the contract");
  assert.equal((await logs(id, "retainer_requested")).length, 0, "the pay link waits for the signature");

  // The pay link on an unsigned contract booking leads to the contract first.
  const b0 = await prisma.booking.findUniqueOrThrow({ where: { id } });
  const open = await get(`/pay/${b0.payToken}`);
  assert.equal(open.status, 303);
  assert.match(open.location ?? "", /^https:\/\/store\.test\/sign\//);

  texts.length = 0;
  const signed = await post(`/api/customer/bookings/${id}/sign`, { fullName: "Jordan Sample", esignConsent: true, consentToElectronicSignature: true, agreeToTerms: true }, cookie);
  assert.equal(signed.status, 201, JSON.stringify(signed.json));
  // The signed copy goes first, then the pay link; both after the reply.
  for (let i = 0; i < 40 && (await logs(id, "retainer_requested")).filter((l) => l.status === "sent").length < 2; i++) await settle(300);
  const sent = await logs(id, "retainer_requested");
  assert.deepEqual(sent.map((l) => [l.channel, l.status]).sort(), [["email", "sent"], ["sms", "sent"]], "signed with the retainer unpaid: the pay link goes by text and email");
  assert.ok(texts.some((t) => t.body.includes("$500.00") && t.body.includes(`https://api.test/pay/${b0.payToken}`)));
  const b = await prisma.booking.findUniqueOrThrow({ where: { id } });
  assert.ok(b.retainerRequestedAt);
  assert.equal(displayStatus(b), "Signed");
  // Now the link goes to Stripe for the retainer.
  assert.match((await get(`/pay/${b0.payToken}`)).location ?? "", /^https:\/\/checkout\.stripe\.test\//);
});

test("texts respect opt-outs: an opted-out number gets the email only, and the skip is logged", async () => {
  await markOptedOut("(860) 555-0477", "staff", `${ZZ} test`);
  try {
    const r = await staffSmall({ phone: "(860) 555-0477" });
    const sent = await logs(r.json.bookingId as string, "retainer_requested");
    assert.equal(sent.find((l) => l.channel === "sms")?.status, "skipped_opted_out");
    assert.equal(sent.find((l) => l.channel === "email")?.status, "sent");
    assert.equal((r.json.payLink as { sent: boolean }).sent, true, "the email went, so it counts as sent");
  } finally {
    await prisma.smsOptOut.deleteMany({ where: { accountId, phone: "+18605550477" } });
  }
});

// ---- 5. retainer reminders --------------------------------------------------------------
test("retainer reminders fire 1, 3 and 7 days after the first ask, then the bell alert, and stop on payment", async () => {
  // A Monday at noon Eastern, at least two days from now, so no reminder day is a Sunday.
  let monday = addDays(easternDay(new Date()), 2);
  while (new Date(`${monday}T12:00:00Z`).getUTCDay() !== 1) monday = addDays(monday, 1);
  const asked = atEastern(monday, 12);
  await prisma.booking.update({ where: { id: phoneBooking }, data: { retainerRequestedAt: asked, eventDate: new Date(`${addDays(monday, 40)}T00:00:00Z`) } });
  await prisma.bookingUnit.updateMany({ where: { bookingId: phoneBooking }, data: { eventDate: new Date(`${addDays(monday, 40)}T00:00:00Z`) } });
  const at = (d: number, hour = 10, min = 5) => new Date(atEastern(addDays(monday, d), hour).getTime() + min * 60_000);
  const retainer = async (now: Date) => (await loadPlans({ bookingId: phoneBooking, now }))[0].plan.items.filter((i) => i.seriesId === "retainer" && i.channel === "sms");
  const states = async (now: Date) => (await retainer(now)).map((i) => i.state);

  let items = await retainer(at(0, 13));
  assert.deepEqual(items.map((i) => easternDay(i.dueAt)), [addDays(monday, 1), addDays(monday, 3), addDays(monday, 7)], "due 1, 3 and 7 days after the ask");
  assert.deepEqual(await states(at(0, 13)), ["scheduled", "scheduled", "scheduled"]);
  assert.deepEqual(await states(at(1, 9, 0)), ["scheduled", "scheduled", "scheduled"], "not before 10 AM");
  assert.deepEqual(await states(at(1)), ["due", "scheduled", "scheduled"]);

  texts.length = 0;
  const run1 = await runAutomation({ dryRun: false, source: "admin", now: at(1) });
  assert.ok(run1, "the run finished");
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: phoneBooking } });
  const first = await prisma.messageLog.findUniqueOrThrow({ where: { idempotencyKey: `retainer_reminder:${phoneBooking}:1:sms` } });
  assert.equal(first.status, "sent");
  assert.ok(first.body.includes("$45.00") && first.body.includes(`https://api.test/pay/${b.payToken}`), first.body);
  assert.deepEqual(await states(at(1, 11)), ["sent", "scheduled", "scheduled"]);
  await runAutomation({ dryRun: false, source: "admin", now: at(1, 12) });
  assert.equal(await prisma.messageLog.count({ where: { bookingId: phoneBooking, triggerKey: "retainer_reminder", channel: "sms" } }), 1, "a second pass sends nothing twice");

  assert.deepEqual(await states(at(3)), ["sent", "due", "scheduled"]);
  await runAutomation({ dryRun: false, source: "admin", now: at(3) });
  assert.deepEqual(await states(at(7)), ["sent", "sent", "due"]);
  assert.equal((await findDueNotifications(at(7))).some((x) => x.dedupeKey === `retainer-still-unpaid:${phoneBooking}`), false, "no alert before the last reminder has had its day");
  await runAutomation({ dryRun: false, source: "admin", now: at(7) });
  assert.deepEqual(await states(at(7, 11)), ["sent", "sent", "sent"]);
  const alert = (await findDueNotifications(at(8))).find((x) => x.dedupeKey === `retainer-still-unpaid:${phoneBooking}`);
  assert.ok(alert, "the day after the last reminder staff get the alert");
  assert.equal(alert.title, "Retainer still unpaid");

  // Paid: a booking asked at the same moment that pays after the first reminder gets no more.
  const other = await staffSmall({ sendPayLink: false });
  const otherId = other.json.bookingId as string;
  await prisma.booking.update({ where: { id: otherId }, data: { retainerRequestedAt: asked, eventDate: new Date(`${addDays(monday, 41)}T00:00:00Z`) } });
  await prisma.bookingUnit.updateMany({ where: { bookingId: otherId }, data: { eventDate: new Date(`${addDays(monday, 41)}T00:00:00Z`) } });
  const otherStates = async (now: Date) => (await loadPlans({ bookingId: otherId, now }))[0].plan.items.filter((i) => i.seriesId === "retainer" && i.channel === "sms").map((i) => [i.state, i.reason ?? ""]);
  assert.deepEqual((await otherStates(at(1))).map((s) => s[0]), ["due", "scheduled", "scheduled"]);
  await post(`/api/bookings/${otherId}/payments`, { kind: "retainer", amountCents: 4500, method: "cash", note: null });
  assert.deepEqual(await otherStates(at(3)), [["stopped", "Stopped: retainer paid"], ["stopped", "Stopped: retainer paid"], ["stopped", "Stopped: retainer paid"]]);
  assert.equal((await findDueNotifications(at(8))).some((x) => x.dedupeKey === `retainer-still-unpaid:${otherId}`), false, "and no alert");

  // Cancelled stops them too.
  await prisma.booking.update({ where: { id: phoneBooking }, data: { status: "Cancelled" } });
  assert.equal((await findDueNotifications(at(8))).some((x) => x.dedupeKey === `retainer-still-unpaid:${phoneBooking}`), false);
  await prisma.booking.update({ where: { id: phoneBooking }, data: { status: "Held" } });
});

// ---- 6. the balance reminder carries the link ---------------------------------------------
test("a balance reminder states the amount and the due date and carries the pay link", async () => {
  const r = await staffSmall({ sendPayLink: false });
  const id = r.json.bookingId as string;
  await post(`/api/bookings/${id}/payments`, { kind: "retainer", amountCents: 4500, method: "cash", note: null });
  const b = await prisma.booking.findUniqueOrThrow({ where: { id } });
  const planned = (await loadPlans({ bookingId: id }))[0];
  assert.equal(planned.send.context.extra?.balanceDue, "$180.00", "the real balance: $225 less the $45 paid");
  assert.equal(planned.send.context.extra?.payLink, `https://api.test/pay/${b.payToken}`);
  assert.ok(planned.send.context.extra?.balanceDueDate);
  assert.ok(planned.plan.items.filter((i) => i.seriesId === "balance").every((i) => i.state !== "blocked"), "nothing is missing for the message");
  // By hand, the button sends the balance link with the amount and the due day.
  emails.length = 0;
  const manual = await post(`/api/bookings/${id}/pay-link/send`, {});
  assert.equal(manual.json.sent, true, JSON.stringify(manual.json));
  assert.equal(manual.json.step, "balance");
  assert.ok(emails.some((e) => e.body.includes("$180.00") && e.body.includes(`/pay/${b.payToken}`) && /due \w{3}, \w{3} \d+/.test(e.body)), JSON.stringify(emails));
  assert.match((await get(`/pay/${b.payToken}`)).location ?? "", /^https:\/\/checkout\.stripe\.test\//);
  const created = stripeCalls.filter((c) => c.path === "/v1/checkout/sessions" && c.method === "POST").at(-1)!;
  assert.ok(created.body.includes("=18000"), "the balance, computed on the server");
});

// ---- the same Stripe event twice ------------------------------------------------------------
test("the same Stripe event twice records one payment, one confirmation and one alert", async () => {
  const { cookie } = await signUp();
  const r = await storefrontHold(cookie);
  const id = r.json.bookingId as string;
  const sessionId = (r.json.payment as { sessionId: string }).sessionId;
  const [a, b] = await Promise.all([paidEvent(sessionId, "evt_f1zz_twice"), paidEvent(sessionId, "evt_f1zz_twice")]);
  assert.deepEqual([a.json.duplicate, b.json.duplicate].sort(), [false, true], "one of the two is a duplicate");
  const again = await paidEvent(sessionId, "evt_f1zz_twice");
  assert.equal(again.json.duplicate, true);
  // A second, different event for the same session (Stripe can send both).
  await paidEvent(sessionId, "evt_f1zz_twice_other");
  await settle();
  const payments = await prisma.payment.findMany({ where: { bookingId: id } });
  assert.equal(payments.filter((p) => p.status === "succeeded").length, 1);
  assert.equal(payments.length, 1, "one payment row");
  assert.equal(await prisma.notification.count({ where: { bookingId: id, type: "payment-received" } }), 1);
  assert.equal((await logs(id, "booking_confirmed")).filter((l) => l.channel === "sms").length, 1);

  // The webhook and the status check landing together: only one of them settles it.
  const r2 = await storefrontHold(cookie);
  const p = await prisma.payment.findFirstOrThrow({ where: { bookingId: r2.json.bookingId as string } });
  const won = await Promise.all([settlePayment(p.id), settlePayment(p.id), settlePayment(p.id)]);
  assert.equal(won.filter(Boolean).length, 1);
  assert.equal(await prisma.notification.count({ where: { bookingId: r2.json.bookingId as string, type: "payment-received" } }), 1);
});

// ---- 7. cancellation requests and the refund log --------------------------------------------
test("a cancellation request with a paid retainer returns the terms, needs them accepted, and frees nothing; Decline changes nothing; Approve frees the units; a refund log entry moves no money", async () => {
  const { cookie, customerId } = await signUp();
  const r = await storefrontHold(cookie);
  const id = r.json.bookingId as string;
  await paidEvent((r.json.payment as { sessionId: string }).sessionId);
  await settle();
  const held = await unitsHeld(id);
  assert.equal(held, 1);

  const preview = await get(`/api/customer/bookings/${id}/cancel`, cookie);
  assert.equal(preview.json.termsRequired, true);
  assert.equal(preview.json.paid, 45);
  assert.match((preview.json.terms as { text: string }).text, /retainer/i);

  const noTerms = await post(`/api/customer/bookings/${id}/cancel`, { reason: "We moved the party" }, cookie);
  assert.equal(noTerms.status, 409);
  assert.equal(noTerms.json.reason, "terms-required");
  assert.match((noTerms.json.terms as { text: string }).text, /non-refundable/);
  assert.equal(await prisma.cancellationRequest.count({ where: { bookingId: id } }), 0);

  emails.length = 0;
  const asked = await post(`/api/customer/bookings/${id}/cancel`, { reason: "We moved the party to https://evil.test", acceptTerms: true }, cookie);
  assert.equal(asked.status, 202, JSON.stringify(asked.json));
  assert.equal(asked.json.cancellationRequested, true);
  assert.equal((asked.json.cancellationRequest as { status: string; termsAccepted: boolean }).status, "open");
  assert.equal((asked.json.cancellationRequest as { termsAccepted: boolean }).termsAccepted, true);
  assert.equal((asked.json.pendingRequest as { type: string }).type, "cancellation");
  assert.equal(asked.json.stage, "Confirmed", "the booking reads as it did");
  let b = await prisma.booking.findUniqueOrThrow({ where: { id } });
  assert.equal(b.status, "Held", "the booking is not cancelled");
  assert.equal(await unitsHeld(id), held, "nothing is freed");
  const req = await prisma.cancellationRequest.findFirstOrThrow({ where: { bookingId: id } });
  assert.equal(req.customerId, customerId);
  assert.equal(req.paidCents, 4500);
  assert.ok(req.termsAcceptedAt && req.termsText?.includes("non-refundable"), "what they accepted is kept");
  assert.equal(req.reason?.includes("http"), false, "links are stripped from the reason");
  // Asking again returns the same request.
  const twice = await post(`/api/customer/bookings/${id}/cancel`, { reason: "again", acceptTerms: true }, cookie);
  assert.equal(twice.status, 200);
  assert.equal(await prisma.cancellationRequest.count({ where: { bookingId: id } }), 1);
  // Someone else cannot ask for this booking.
  const stranger = await signUp();
  assert.equal((await post(`/api/customer/bookings/${id}/cancel`, { acceptTerms: true }, stranger.cookie)).status, 404);

  // Staff: the bell, the lead tag, the list with what was paid and why.
  const bell = await prisma.notification.findFirstOrThrow({ where: { dedupeKey: `cancellation-request:${req.id}` } });
  assert.equal(bell.title, "Cancellation request");
  assert.match(bell.body, /\$45 paid so far/);
  assert.equal(bell.link, `/leads?lead=${b.leadId}`);
  assert.ok((await prisma.lead.findUniqueOrThrow({ where: { id: b.leadId as string } })).tags.includes("Cancellation request"));
  const list = await get(`/api/cancellation-requests?status=Open&leadId=${b.leadId}`);
  const card = (list.json.requests as Record<string, unknown>[])[0];
  assert.equal(card.id, req.id);
  assert.equal(card.paidCents, 4500);
  assert.equal((card.booking as { email: string }).email, b.email);

  // Decline: nothing changes, the customer is emailed.
  const declined = await post(`/api/cancellation-requests/${req.id}/decline`, { note: "Spoke to them, keeping it" });
  assert.equal(declined.status, 200, JSON.stringify(declined.json));
  assert.equal(declined.json.customerTold, true);
  b = await prisma.booking.findUniqueOrThrow({ where: { id } });
  assert.equal(b.status, "Held");
  assert.equal(displayStatus(b), "Confirmed");
  assert.equal(await unitsHeld(id), held, "Decline changes nothing");
  assert.ok(emails.some((e) => /cancellation request/i.test(e.subject) && e.body.includes("has not been cancelled")));
  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: b.leadId as string } })).tags.includes("Cancellation request"), false);
  assert.ok((await prisma.notification.findUniqueOrThrow({ where: { id: bell.id } })).readAt, "the alert is settled");
  assert.equal((await post(`/api/cancellation-requests/${req.id}/approve`, {})).status, 409, "a decided request cannot be decided again");

  // A new request, approved: the booking is cancelled and the units are free.
  const asked2 = await post(`/api/customer/bookings/${id}/cancel`, { reason: "Still need to cancel", acceptTerms: true }, cookie);
  assert.equal(asked2.status, 202, JSON.stringify(asked2.json));
  const req2 = await prisma.cancellationRequest.findFirstOrThrow({ where: { bookingId: id, status: "Open" } });
  emails.length = 0;
  const stripeBefore = stripeCalls.length;
  const approved = await post(`/api/cancellation-requests/${req2.id}/approve`, { note: null });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  b = await prisma.booking.findUniqueOrThrow({ where: { id } });
  assert.equal(b.status, "Cancelled");
  assert.equal(await unitsHeld(id), 0, "Approve frees the units");
  assert.ok(emails.some((e) => e.subject === "Your booking is cancelled"));

  // The refund log: a record, and nothing else.
  const payBefore = await prisma.payment.findMany({ where: { bookingId: id }, orderBy: { createdAt: "asc" } });
  const logged = await post(`/api/bookings/${id}/refunds`, { amountCents: 4500, refundedOn: day(0), method: "stripe", note: "Goodwill, agreed by Mel", cancellationRequestId: req2.id });
  assert.equal(logged.status, 201, JSON.stringify(logged.json));
  assert.equal((logged.json.refunds as { amountCents: number; recordedByName: string }[])[0].amountCents, 4500);
  assert.equal((logged.json.refunds as { recordedByName: string }[])[0].recordedByName, "ZZ Owner");
  assert.equal(stripeCalls.length, stripeBefore, "no call to Stripe: approving and logging a refund move no money");
  assert.deepEqual(await prisma.payment.findMany({ where: { bookingId: id }, orderBy: { createdAt: "asc" } }), payBefore, "no payment row changed");
  assert.equal((await post(`/api/bookings/${id}/refunds`, { amountCents: 0, refundedOn: day(0), method: "stripe" })).status, 400);
  assert.equal((await post(`/api/bookings/${id}/refunds`, { amountCents: 100, refundedOn: day(0), method: "wire" })).status, 400);
});

test("an unpaid booking can ask to cancel without terms, and is still held until staff decide", async () => {
  const { cookie } = await signUp();
  const r = await storefrontHold(cookie);
  const id = r.json.bookingId as string;
  const asked = await post(`/api/customer/bookings/${id}/cancel`, {}, cookie);
  assert.equal(asked.status, 202, JSON.stringify(asked.json));
  assert.equal(asked.json.terms, null);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id } })).status, "Held");
  assert.equal(await unitsHeld(id), 1);
});

// ---- 8. Overview ----------------------------------------------------------------------------
test("Overview: Money in lists the week's payments with a total; Waiting on payment lists unpaid retainers and balances due soon", async () => {
  const soon = await staffSmall({ sendPayLink: false, eventDate: day(20) });
  await post(`/api/bookings/${soon.json.bookingId}/payments`, { kind: "retainer", amountCents: 4500, method: "cash", note: null });
  const o = await get("/api/money/overview");
  assert.equal(o.status, 200, JSON.stringify(o.json));
  const moneyIn = o.json.moneyIn as { totalCents: number; payments: { bookingId: string; amountCents: number }[] };
  assert.ok(moneyIn.payments.length >= 4);
  assert.equal(moneyIn.totalCents, moneyIn.payments.reduce((s, p) => s + p.amountCents, 0));
  const waiting = o.json.waiting as { retainers: { bookingId: string; amountCents: number }[]; balances: { bookingId: string; amountCents: number; dueDate: string }[] };
  assert.ok(waiting.retainers.some((x) => x.bookingId === phoneBooking && x.amountCents === 4500), "the unpaid retainer is listed");
  const bal = waiting.balances.find((x) => x.bookingId === soon.json.bookingId);
  assert.ok(bal, "a balance on an event 20 days out is due within 14 days (30 days before the event)");
  assert.equal(bal.amountCents, 18000);
});
