// Block T1, end to end over HTTP on a throwaway database: the tier
// endpoint, the hold for tiers 1 and 2 with the quote refusals, the portal
// (contract ownership, steps, self-serve refusal, Released), Stripe (mocked)
// from the session to the webhook, refunds and disputes, Stripe missing, and
// the address check (mocked Google). Twilio and the email webhook are
// stubbed. Every row made here is deleted at the end with counts.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.ADMIN_PASSWORD = "zz-shared";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.STOREFRONT_URL = "https://store.test";
process.env.PUBLIC_API_URL = "https://api.test";
process.env.STRIPE_SECRET_KEY = "sk_test_zz";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_zz_test";
process.env.GOOGLE_MAPS_SERVER_KEY = "zz-maps-key";
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "https://store.test";
delete process.env.EMAIL_WEBHOOK_URL;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { addDays } from "../automation/time.js";
import { prisma } from "../db.js";
import { setMapsFetch, verifyBookingAddress } from "../delivery.js";
import { sendContract } from "../notify.js";
import { refundPayment } from "../payments.js";
import { customerWriteGuard } from "../security.js";
import { setStripeFetch, signWebhookPayload } from "../stripe/client.js";
import customerRouter from "../routes/customer.js";
import directBookingsRouter from "../routes/directBookings.js";
import { publicPaymentsRouter } from "../routes/payments.js";
import stripeWebhookRouter from "../routes/stripeWebhook.js";
import tierRouter from "../routes/tier.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("checkout.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const made = { items: [] as string[], customers: [] as string[], bookings: [] as string[], quotes: [] as string[], events: [] as string[], statuses: [] as string[] };
let settingsBefore: Record<string, unknown> | null = null;
let small = "";
let big = "";
const texts: { to: string; body: string }[] = [];

// ---- stubs ---------------------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) {
    const b = new URLSearchParams(String(init?.body));
    texts.push({ to: b.get("To") ?? "", body: b.get("Body") ?? "" });
    return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
  }
  return realFetch(input, init);
}) as typeof fetch;

type Sess = { id: string; client_secret: string; status: string; payment_status: string; payment_intent: string; customer: string | null; amount_total: number; metadata: Record<string, string> };
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
    const s: Sess = { id: `cs_test_zz${sessionCount}`, client_secret: `cs_test_zz${sessionCount}_secret_abc`, status: "open", payment_status: "unpaid", payment_intent: `pi_zz${sessionCount}`, customer: p.get("customer"), amount_total: Number(p.get("line_items[0][price_data][unit_amount]")), metadata: { bookingId: p.get("metadata[bookingId]") ?? "", kind: p.get("metadata[kind]") ?? "" } };
    sessions.set(s.id, s);
    return json(200, s);
  }
  const m = /^\/v1\/checkout\/sessions\/([^/?]+)(\/expire)?/.exec(path);
  if (m) {
    const s = sessions.get(m[1]);
    if (!s) return json(404, { error: { message: "No such session" } });
    if (m[2]) {
      s.status = "expired";
      return json(200, s);
    }
    return json(200, s);
  }
  if (path === "/v1/refunds") return json(200, { id: "re_zz", amount: Number(new URLSearchParams(body).get("amount")), status: "succeeded" });
  return json(400, { error: { message: `unmocked ${path}` } });
});

const places: Record<string, unknown> = {
  "place-ok": { id: "place-ok", formattedAddress: "14 Maple Ln, Avon, CT 06001, USA", location: { latitude: 41.8102, longitude: -72.8309 }, addressComponents: [{ types: ["street_number"], longText: "14", shortText: "14" }, { types: ["route"], longText: "Maple Lane", shortText: "Maple Ln" }, { types: ["postal_code"], longText: "06001", shortText: "06001" }] },
  "place-city": { id: "place-city", formattedAddress: "Avon, CT, USA", location: { latitude: 41.8102, longitude: -72.8309 }, addressComponents: [{ types: ["locality"], longText: "Avon", shortText: "Avon" }] },
  "place-mismatch": { id: "place-mismatch", formattedAddress: "99 Elm St, Avon, CT 06001, USA", location: { latitude: 41.8102, longitude: -72.8309 }, addressComponents: [{ types: ["street_number"], longText: "99", shortText: "99" }, { types: ["route"], longText: "Elm Street", shortText: "Elm St" }] },
};
setMapsFetch((url) => {
  const id = decodeURIComponent(url.split("/v1/places/")[1] ?? "");
  if (id === "place-down") return Promise.reject(new TypeError("fetch failed"));
  const p = places[id];
  return Promise.resolve(new Response(JSON.stringify(p ?? { error: { code: 404 } }), { status: p ? 200 : 404 }));
});

const delivery = (placeId: string) => ({ placeId, formattedAddress: "14 Maple Ln, Avon, CT 06001, USA", components: { streetNumber: "14", route: "Maple Lane", city: "Avon", state: "CT", zip: "06001" }, addressLat: 41.8102, addressLng: -72.8309, setupLat: 41.8103, setupLng: -72.8308, setupNotes: "Backyard, gate on the left" });

// ---- helpers ---------------------------------------------------------------------
type Res = { status: number; json: Record<string, unknown>; cookie: string | null };
async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://store.test", ...((init.headers as Record<string, string>) ?? {}) };
  if (init.cookie) headers.Cookie = init.cookie;
  const r = await realFetch(`${base}${path}`, { ...init, headers });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown>, cookie: set ? set.split(";")[0] : null };
}
const post = (path: string, body: unknown, cookie?: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const day = (n: number) => addDays(new Date().toISOString().slice(0, 10), n);
let holdCount = 0;
// Every hold is on its own date; a tier 2 quote is asked for the same date
// and time the hold then sends (the quote pins the cart, date included).
function holdBody(itemId: string, over: Record<string, unknown> = {}) {
  holdCount += 1;
  return { itemId, eventDate: day(60 + holdCount), eventTime: "2 PM", customerName: `${ZZ} Customer ${holdCount}`, phone: `+150055501${String(holdCount).padStart(2, "0")}`, email: `zz${holdCount}@example.test`, agreedToPolicy: true, delivery: null, ...over };
}
async function tierOf(itemId: string, over: Record<string, unknown> = {}) {
  return post("/api/bookings/tier", { itemId, eventDate: day(90), eventTime: "2 PM", ...over });
}
// A tier 2 quote and the hold body that matches it.
async function quoteAndHold(itemId: string, over: Record<string, unknown> = {}) {
  const body = holdBody(itemId, over);
  const t = await tierOf(itemId, { eventDate: body.eventDate });
  const q = t.json.contract as { quoteId: string; contentHash: string };
  made.quotes.push(q.quoteId);
  return { body, q };
}
async function webhook(event: Record<string, unknown>, secret = process.env.STRIPE_WEBHOOK_SECRET as string, signedAt = new Date()) {
  const raw = JSON.stringify(event);
  if (typeof event.id === "string") made.events.push(event.id);
  const r = await realFetch(`${base}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": signWebhookPayload(raw, secret, signedAt) }, body: raw });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
async function paidEvent(sessionId: string, id = `evt_zz_${sessionId}`) {
  const s = sessions.get(sessionId) as Sess;
  s.status = "complete";
  s.payment_status = "paid";
  return webhook({ id, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { id: s.id, payment_status: "paid", payment_intent: s.payment_intent, metadata: s.metadata } } });
}
const track = (r: Res) => {
  if (typeof r.json.bookingId === "string") made.bookings.push(r.json.bookingId);
  return r;
};

// ---- setup ---------------------------------------------------------------------
before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  settingsBefore = { contractRequiredOver: a.contractRequiredOver, contractRequiredForCrewed: a.contractRequiredForCrewed, fullReviewThreshold: a.fullReviewThreshold, reviewOccasions: a.reviewOccasions, depositPercentage: a.depositPercentage, authorizedSignerName: a.authorizedSignerName, authorizedSignerTitle: a.authorizedSignerTitle, tier1Collect: a.tier1Collect, rushContactPhone: a.rushContactPhone };
  await prisma.account.update({ where: { id: accountId }, data: { contractRequiredOver: 1000, contractRequiredForCrewed: true, fullReviewThreshold: 15000, reviewOccasions: ["Wedding"], depositPercentage: 20, authorizedSignerName: "Mel Owner", authorizedSignerTitle: "Owner", tier1Collect: "retainer", rushContactPhone: "+15005550099" } });
  if ((await prisma.leadStatus.count({ where: { accountId } })) === 0) {
    const s = await prisma.leadStatus.create({ data: { accountId, name: "New", position: 0 } });
    made.statuses.push(s.id);
  }
  const policy = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  if (!policy || policy.text.trim() === "") await prisma.policyVersion.create({ data: { accountId, version: (policy?.version ?? 0) + 1, text: `${ZZ} rental policy: the retainer is {{depositPercentage}}% and non-refundable.` } });
  const s = await prisma.item.create({ data: { accountId, name: `${ZZ} Bounce House`, category: "Bounce House", price: 300, priceUnit: "per day", units: { create: [{ label: "Unit 1" }, { label: "Unit 2" }, { label: "Unit 3" }] } } });
  const b = await prisma.item.create({ data: { accountId, name: `${ZZ} Big Tent`, category: "Tents", price: 2500, priceUnit: "per event", units: { create: [{ label: "Tent A" }, { label: "Tent B" }, { label: "Tent C" }, { label: "Tent D" }] } } });
  const c = await prisma.item.create({ data: { accountId, name: `${ZZ} DJ`, category: "DJ and MC", price: 400, priceUnit: "per event", skills: ["DJ"] } });
  made.items.push(s.id, b.id, c.id);
  small = s.id;
  big = b.id;

  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/customer", customerWriteGuard);
  app.use("/api/bookings/direct", customerWriteGuard);
  app.use("/api/bookings/tier", customerWriteGuard);
  app.use("/api/webhooks/stripe", express.raw({ type: "*/*", limit: "1mb" }));
  app.use(express.json({ limit: "50kb" }));
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/webhooks/stripe", stripeWebhookRouter);
  app.use("/api/payments", publicPaymentsRouter);
  app.use("/api/bookings/direct", directBookingsRouter);
  app.use("/api/bookings/tier", tierRouter);
  app.use("/api/customer", customerRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  globalThis.fetch = realFetch;
  setStripeFetch(null);
  setMapsFetch(null);
  const logs = await prisma.messageLog.deleteMany({ where: { OR: [{ bookingId: { in: made.bookings } }, { recipient: { startsWith: "+1500555" } }] } });
  const b = await prisma.booking.deleteMany({ where: { id: { in: made.bookings } } });
  const l = await prisma.lead.deleteMany({ where: { customerName: { startsWith: ZZ } } });
  const q = await prisma.quote.deleteMany({ where: { id: { in: made.quotes } } });
  const e = await prisma.stripeEvent.deleteMany({ where: { id: { in: made.events } } });
  const c = await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
  const i = await prisma.item.deleteMany({ where: { id: { in: made.items } } });
  const st = await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } });
  if (settingsBefore) await prisma.account.update({ where: { id: accountId }, data: settingsBefore as object });
  const left = { bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }), items: await prisma.item.count({ where: { name: { startsWith: ZZ } } }), customers: await prisma.customer.count({ where: { email: { endsWith: "@example.test" } } }) };
  console.log(`# cleanup: ${b.count} bookings, ${l.count} leads, ${q.count} quotes, ${e.count} stripe events, ${c.count} customers, ${i.count} items, ${st.count} lead columns, ${logs.count} message logs; remaining ${JSON.stringify(left)}`);
  await prisma.$disconnect();
});

// ---- the tier endpoint -------------------------------------------------------------
test("tier: a small rental is tier 1 with the policy; over the threshold or crewed is tier 2 with a quote; a review occasion is tier 3", async () => {
  const t1 = await tierOf(small);
  assert.equal(t1.status, 200);
  assert.equal(t1.json.tier, 1);
  assert.equal(t1.json.total, 300);
  assert.equal(t1.json.retainerAmount, 60);
  assert.match((t1.json.policy as { text: string }).text, /non-refundable/);
  assert.equal(t1.json.contract, null);

  const t2 = await tierOf(big);
  assert.equal(t2.json.tier, 2);
  assert.deepEqual(t2.json.reasons, ["over-contract-threshold"]);
  const q = t2.json.contract as { quoteId: string; contentHash: string; format: string; termsVersion: number; document: { header: { confirmByDate: string }; payment: { total: number; retainerAmount: number }; client: { nameOrg: string | null }; signatures: { go: { printedName: string } | null } } };
  made.quotes.push(q.quoteId);
  assert.equal(q.format, "go-v2");
  assert.match(q.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(q.document.payment.total, 250000);
  assert.equal(q.document.payment.retainerAmount, 50000);
  assert.equal(q.document.client.nameOrg, null, "the quote prints the client fields empty");
  assert.equal(q.document.signatures.go?.printedName, "Mel Owner", "GO's signature is on the quote");
  assert.ok(q.document.header.confirmByDate);
  assert.match(String(t2.json.quoteExpiresAt), /T0[34]:59:59\.000Z$/, "expires at the end of the day, Eastern");
  assert.equal(t2.json.retainerAmount, 500);

  const crew = await tierOf(made.items[2]);
  assert.equal(crew.json.tier, 2);
  assert.deepEqual(crew.json.reasons, ["crewed"]);
  made.quotes.push((crew.json.contract as { quoteId: string }).quoteId);

  const t3 = await tierOf(small, { occasion: "Wedding" });
  assert.equal(t3.json.tier, 3);
  assert.equal(t3.json.contract, null);
  assert.equal(t3.json.quoteExpiresAt, null);

  const same = await tierOf(big);
  made.quotes.push((same.json.contract as { quoteId: string }).quoteId);
  assert.equal((same.json.contract as { contentHash: string }).contentHash, q.contentHash, "the same cart on the same day hashes the same");
});

// ---- tier 1: hold, pay, webhook ----------------------------------------------------
let smallSession = "";
let smallBooking = "";
test("tier 1 hold: held, policy agreed, a retainer session offered; the webhook marks it paid once", async () => {
  const r = track(await post("/api/bookings/direct", holdBody(small, { tier: 1 })));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.tier, 1);
  assert.equal(r.json.stage, "Held");
  assert.equal(r.json.contract, null);
  const pay = r.json.payment as { kind: string; amount: number; clientSecret: string; sessionId: string };
  assert.equal(pay.kind, "retainer");
  assert.equal(pay.amount, 60, "20% of 300, computed on the server");
  assert.match(pay.clientSecret, /_secret_/);
  smallSession = pay.sessionId;
  smallBooking = r.json.bookingId as string;
  const created = stripeCalls.find((c) => c.path === "/v1/checkout/sessions");
  assert.ok(created);
  assert.ok(created.body.includes("ui_mode=embedded") && created.body.includes("redirect_on_completion=never"));
  assert.ok(created.body.includes(`${encodeURIComponent("line_items[0][price_data][unit_amount]")}=6000`), "the amount is cents on the server");

  const open = await call(`/api/payments/status?sessionId=${smallSession}`);
  assert.deepEqual(open.json, { status: "open", paid: false, bookingId: smallBooking, kind: "retainer" });

  const bad = await webhook({ id: "evt_zz_bad", type: "checkout.session.completed", created: 1, data: { object: { id: smallSession } } }, "whsec_wrong");
  assert.equal(bad.status, 400);
  assert.equal(await prisma.stripeEvent.count({ where: { id: "evt_zz_bad" } }), 0, "a bad signature writes nothing");

  texts.length = 0;
  const ok = await paidEvent(smallSession);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { received: true, duplicate: false, handled: true });
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: smallBooking }, include: { payments: true } });
  assert.equal(b.retainerPaid, true);
  assert.equal(b.payments[0].status, "succeeded");
  const done = await call(`/api/payments/status?sessionId=${smallSession}`);
  assert.equal(done.json.paid, true);
  assert.equal(done.json.status, "complete");
  await new Promise((r) => setTimeout(r, 300));
  const retainerMsgs = await prisma.messageLog.findMany({ where: { bookingId: smallBooking, triggerKey: "retainer_paid", channel: "sms" } });
  assert.equal(retainerMsgs.length, 1, "the retainer message fired from the webhook");

  const again = await paidEvent(smallSession);
  assert.deepEqual(again.json, { received: true, duplicate: true, handled: false });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await prisma.messageLog.count({ where: { bookingId: smallBooking, triggerKey: "retainer_paid", channel: "sms" } }), 1, "a replay sends nothing twice");
});

// ---- tier 2: the quote refusals and the signed hold ----------------------------------
test("tier 2 hold: the three refusals, then a signed hold with the contract stored and the retainer offered", async () => {
  const { body, q } = await quoteAndHold(big);
  const sig = (over: Record<string, unknown> = {}) => ({ fullName: "Jordan Sample", esignConsent: true, contentHash: q.contentHash, quoteId: q.quoteId, ...over });

  const noSig = await post("/api/bookings/direct", { ...body, tier: 2 });
  assert.equal(noSig.status, 400);
  assert.equal(noSig.json.reason, "agreement-required");

  const wrongTier = await post("/api/bookings/direct", { ...body, tier: 1 });
  assert.equal(wrongTier.status, 409);
  assert.equal(wrongTier.json.reason, "tier-changed");

  const sigOnSmall = await post("/api/bookings/direct", { ...body, itemId: small, tier: 2, signature: sig() });
  assert.equal(sigOnSmall.status, 409);
  assert.equal(sigOnSmall.json.reason, "tier-changed");

  const changed = await post("/api/bookings/direct", { ...body, tier: 2, signature: sig({ contentHash: "a".repeat(64) }) });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.reason, "contract-changed");

  // The cart changed under the quote: a second item changes the contract.
  const cartChanged = await post("/api/bookings/direct", { ...body, tier: 2, signature: sig(), itemId: undefined, itemIds: [big, small] });
  assert.equal(cartChanged.status, 409);
  assert.equal(cartChanged.json.reason, "contract-changed");

  // So does a different date or time for the same items.
  const dateChanged = await post("/api/bookings/direct", { ...body, tier: 2, signature: sig(), eventDate: day(150) });
  assert.equal(dateChanged.json.reason, "contract-changed");

  await prisma.quote.update({ where: { id: q.quoteId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  const expired = await post("/api/bookings/direct", { ...body, tier: 2, signature: sig() });
  assert.equal(expired.status, 409);
  assert.equal(expired.json.reason, "quote-expired");
  await prisma.quote.update({ where: { id: q.quoteId }, data: { expiresAt: new Date(Date.now() + 3_600_000) } });

  texts.length = 0;
  const held = track(await post("/api/bookings/direct", { ...body, tier: 2, signature: sig(), delivery: delivery("place-ok"), address: "14 Maple Ln, Avon, CT 06001, USA" }));
  assert.equal(held.status, 201, JSON.stringify(held.json));
  assert.equal(held.json.tier, 2);
  assert.equal(held.json.stage, "Requested");
  const contract = held.json.contract as { agreementId: string; signed: boolean; signedAt: string; pdfUrl: string };
  assert.equal(contract.signed, true);
  assert.match(contract.pdfUrl, /^https:\/\/api\.test\/api\/contracts\/pdf\//);
  const pay = held.json.payment as { amount: number; sessionId: string };
  assert.equal(pay.amount, 500, "20% of the contract total");

  const b = await prisma.booking.findUniqueOrThrow({ where: { id: held.json.bookingId as string }, include: { agreement: { include: { contractDocument: true } } } });
  assert.equal(b.status, "Signed");
  assert.equal(b.tier, 2);
  assert.equal(b.agreement?.contractStatus, "Signed");
  assert.equal(b.agreement?.format, "go-v2");
  assert.equal(b.agreement?.quoteId, q.quoteId);
  assert.equal(b.agreement?.goSignerName, "Mel Owner");
  assert.ok(b.agreement?.contractSentAt);
  assert.ok(b.agreement?.confirmByDate);
  assert.equal(b.agreement?.contractDocument?.signedName, "Jordan Sample");
  const doc = b.agreement?.contractDocument?.documentJson as { client: { nameOrg: string; mailingAddress: string; city: string }; signatures: { client: { printedName: string } } };
  assert.equal(doc.client.nameOrg, b.customerName, "the stored document carries the client fields from the hold");
  assert.equal(doc.client.mailingAddress, "14 Maple Lane");
  assert.equal(doc.client.city, "Avon");
  assert.equal(doc.signatures.client.printedName, "Jordan Sample");
  assert.ok(b.agreement?.contractDocument?.pdf.length, "the PDF was stored");
  assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: q.quoteId } })).usedByBookingId, b.id, "the quote is used up");
  assert.equal(b.placeId, "place-ok");
  assert.equal(b.setupNotes, "Backyard, gate on the left");

  const reuse = await post("/api/bookings/direct", { ...body, tier: 2, signature: sig(), phone: "+15005550177", email: "zzreuse@example.test" });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.json.reason, "quote-expired", "a used quote cannot hold twice");

  // The address check ran after the reply.
  await new Promise((r) => setTimeout(r, 400));
  const checked = await prisma.booking.findUniqueOrThrow({ where: { id: b.id }, select: { addressCheck: true } });
  assert.equal(checked.addressCheck, "verified");
});

// ---- Stripe: refund and dispute, then Stripe missing -----------------------------------
test("a paid retainer can be partly refunded through Stripe; a dispute flags the booking", async () => {
  const p = await prisma.payment.findFirstOrThrow({ where: { bookingId: smallBooking, kind: "retainer" } });
  const { payment } = await refundPayment(p.id, 1000, "Goodwill");
  assert.equal(payment.refundedCents, 1000);
  assert.equal(payment.status, "succeeded");
  assert.ok(stripeCalls.some((c) => c.path === "/v1/refunds" && c.body.includes("amount=1000")));
  await webhook({ id: "evt_zz_refund", type: "charge.refunded", created: 1, data: { object: { id: "ch_zz", payment_intent: p.stripePaymentIntentId, amount_refunded: 1000 } } });
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).refundedCents, 1000);
  await assert.rejects(refundPayment(p.id, 6000, null), /between/);

  const d = await webhook({ id: "evt_zz_dispute", type: "charge.dispute.created", created: 1, data: { object: { id: "dp_zz", payment_intent: p.stripePaymentIntentId, reason: "fraudulent", amount: 6000 } } });
  assert.equal(d.json.handled, true);
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: smallBooking } });
  assert.ok(b.disputeFlaggedAt);
  assert.match(b.disputeNote ?? "", /disputed/);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status, "disputed");
});

test("with Stripe not set up, the hold still stands and payment is null everywhere", async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const r = track(await post("/api/bookings/direct", holdBody(small, { tier: 1 })));
    assert.equal(r.status, 201);
    assert.equal(r.json.payment, null);
    const wh = await webhook({ id: "evt_zz_nokey", type: "checkout.session.completed", created: 1, data: { object: { id: "cs_none" } } });
    assert.equal(wh.status, 200, "the webhook secret alone still verifies events");
  } finally {
    process.env.STRIPE_SECRET_KEY = key;
  }
  const both = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    const wh = await webhook({ id: "evt_zz_nosecret", type: "checkout.session.completed", created: 1, data: { object: { id: "cs_none" } } }, "whsec_zz_test");
    assert.equal(wh.status, 503);
  } finally {
    process.env.STRIPE_WEBHOOK_SECRET = both;
  }
});

// ---- the portal ------------------------------------------------------------------------
test("portal: a customer sees tier, stage, steps, contract and money on their own booking only; tier 2 cannot self-serve; Released reads as such", async () => {
  const x = await post("/api/customer/signup", { name: `${ZZ} Alex`, phone: "+15005550181", email: "zzalex@example.test", password: "a-long-password-zz1" });
  assert.equal(x.status, 201, JSON.stringify(x.json));
  made.customers.push((x.json.customer as { id: string }).id);
  const xc = x.cookie as string;
  const y = await post("/api/customer/signup", { name: `${ZZ} Yan`, phone: "+15005550182", email: "zzyan@example.test", password: "a-long-password-zz2" });
  made.customers.push((y.json.customer as { id: string }).id);
  const yc = y.cookie as string;

  const { body, q } = await quoteAndHold(big);
  const held = track(await post("/api/bookings/direct", { ...body, tier: 2, signature: { fullName: "Alex Sample", esignConsent: true, contentHash: q.contentHash, quoteId: q.quoteId }, customerName: undefined, phone: undefined, email: undefined }, xc));
  assert.equal(held.status, 201, JSON.stringify(held.json));
  const id = held.json.bookingId as string;
  const rental = track(await post("/api/bookings/direct", { ...holdBody(small, { tier: 1 }), customerName: undefined, phone: undefined, email: undefined }, xc));
  assert.equal(rental.status, 201);

  const list = await call("/api/customer/bookings", { cookie: xc });
  assert.equal(list.status, 200);
  const rows = list.json as unknown as Record<string, unknown>[];
  const mine = rows.find((r) => r.id === id) as Record<string, unknown>;
  assert.equal(mine.tier, 2);
  assert.equal(mine.stage, "Requested");
  assert.equal(mine.rescheduleMode, "request");
  assert.equal(mine.pendingRequest, null);
  assert.deepEqual((mine.steps as { key: string; state: string }[]).map((s) => [s.key, s.state]), [["sign", "done"], ["retainer", "next"], ["balance", "waiting"]]);
  assert.equal((mine.contract as { status: string }).status, "signed");
  assert.deepEqual(mine.retainer, { amount: 500, paid: false, paidAt: null, payable: true });
  assert.equal((mine.balance as { amount: number; payable: boolean }).amount, 2000);
  assert.equal((mine.balance as { payable: boolean }).payable, false);
  assert.equal(mine.delivery, null);
  const small1 = rows.find((r) => r.id === rental.json.bookingId) as Record<string, unknown>;
  assert.equal(small1.tier, 1);
  assert.equal(small1.rescheduleMode, "self");
  assert.equal(small1.contract, null);

  const own = await call(`/api/customer/bookings/${id}/contract`, { cookie: xc });
  assert.equal(own.status, 200);
  assert.equal(own.json.signed, true);
  assert.equal(own.json.format, "go-v2");
  const other = await call(`/api/customer/bookings/${id}/contract`, { cookie: yc });
  assert.equal(other.status, 404, "someone else's contract is a 404");
  const none = await call(`/api/customer/bookings/${rental.json.bookingId}/contract`, { cookie: xc });
  assert.equal(none.status, 404, "a rental has no contract");

  const cancel = await post(`/api/customer/bookings/${id}/cancel`, {}, xc);
  assert.equal(cancel.status, 409);
  assert.equal(cancel.json.error, "Call or text GO to change this booking.");
  const move = await post(`/api/customer/bookings/${id}/reschedule`, { eventDate: day(120) }, xc);
  assert.equal(move.status, 409);
  const swap = await post(`/api/customer/bookings/${id}/change-item`, { itemId: small }, xc);
  assert.equal(swap.status, 409);

  const session = await post(`/api/customer/bookings/${id}/payments/session`, { kind: "retainer" }, xc);
  assert.equal(session.status, 200, JSON.stringify(session.json));
  assert.equal(session.json.amount, 500);
  assert.match(String(session.json.clientSecret), /_secret_/);
  const balanceTooSoon = await post(`/api/customer/bookings/${id}/payments/session`, { kind: "balance" }, xc);
  assert.equal(balanceTooSoon.status, 409);
  assert.equal(balanceTooSoon.json.reason, "not-payable");
  const notMine = await post(`/api/customer/bookings/${id}/payments/session`, { kind: "retainer" }, yc);
  assert.equal(notMine.status, 404);

  await paidEvent(session.json.sessionId as string);
  const after = (await call("/api/customer/bookings", { cookie: xc })).json as unknown as Record<string, unknown>[];
  const paid = after.find((r) => r.id === id) as Record<string, unknown>;
  assert.equal(paid.stage, "Confirmed", "signed and paid");
  assert.equal((paid.retainer as { paid: boolean }).paid, true);
  assert.deepEqual((paid.steps as { key: string; state: string }[]).map((s) => [s.key, s.state]), [["sign", "done"], ["retainer", "done"], ["balance", "next"]]);
  assert.equal((paid.balance as { payable: boolean }).payable, true);
  const nothing = await post(`/api/customer/bookings/${id}/payments/session`, { kind: "retainer" }, xc);
  assert.equal(nothing.json.reason, "nothing-due");

  await prisma.booking.update({ where: { id: rental.json.bookingId as string }, data: { status: "Released" } });
  const released = ((await call("/api/customer/bookings", { cookie: xc })).json as unknown as Record<string, unknown>[]).find((r) => r.id === rental.json.bookingId) as Record<string, unknown>;
  assert.equal(released.stage, "Released");
  assert.equal(released.status, "Cancelled", "the old field keeps its meaning");
  assert.deepEqual(released.steps, []);
});

// ---- the contract-ready message link --------------------------------------------------
test("the contract-ready text links to the portal for an account holder and to the token page otherwise", async () => {
  const policy = await prisma.policyVersion.findFirstOrThrow({ where: { accountId }, orderBy: { version: "desc" } });
  const unit = await prisma.unit.findFirstOrThrow({ where: { itemId: big, label: "Tent D" } });
  const customer = await prisma.customer.findFirstOrThrow({ where: { email: "zzalex@example.test" } });
  const mk = async (customerId: string | null, n: number) => {
    const eventDate = new Date(`${day(200 + n)}T00:00:00Z`);
    let id = "";
    await prisma.$transaction(async (tx) => {
      const b = await tx.booking.create({ data: { accountId, customerId, eventDate, customerName: `${ZZ} Link ${n}`, phone: `+150055509${n}`, email: null, status: "Held", total: 100, units: { create: [{ unitId: unit.id, eventDate }] } } });
      await tx.agreement.create({ data: { accountId, bookingId: b.id, customerId, policyVersionId: policy.id, checkboxChecked: true } });
      id = b.id;
    });
    made.bookings.push(id);
    return id;
  };
  texts.length = 0;
  const withAccount = await mk(customer.id, 1);
  const r1 = await sendContract({ bookingId: withAccount }, "manual");
  assert.equal(r1.action, "send-link");
  assert.ok(texts.some((t) => t.body.includes(`https://store.test/party/${withAccount}/contract`)), `expected a portal link in: ${texts.map((t) => t.body).join(" | ")}`);
  texts.length = 0;
  const guest = await mk(null, 2);
  await sendContract({ bookingId: guest }, "manual");
  assert.ok(texts.some((t) => /https:\/\/store\.test\/sign\/[A-Za-z0-9_-]+/.test(t.body)), "a guest gets the token page");
});

// ---- the address check ------------------------------------------------------------------
test("address check: city only and a mismatch need a check, Google down leaves it unchecked, and the hold never waits on it", async () => {
  const run = async (placeId: string) => {
    const r = track(await post("/api/bookings/direct", holdBody(small, { tier: 1, delivery: delivery(placeId), address: "14 Maple Ln, Avon, CT 06001, USA" })));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return verifyBookingAddress(r.json.bookingId as string);
  };
  assert.equal((await run("place-city")).check, "needs_check");
  const mismatch = await run("place-mismatch");
  assert.equal(mismatch.check, "needs_check");
  assert.match(mismatch.reason ?? "", /Google has 99 Elm Street/);
  const down = await run("place-down");
  assert.equal(down.check, "not_checked");
  assert.match(down.reason ?? "", /could not be reached/);
  const bad = await post("/api/bookings/direct", holdBody(small, { tier: 1, delivery: { placeId: "x", formattedAddress: "Avon", components: { city: "Avon" }, addressLat: 1, addressLng: 1, setupLat: 1, setupLng: 1, setupNotes: "" } }));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.reason, "delivery-invalid");
});
