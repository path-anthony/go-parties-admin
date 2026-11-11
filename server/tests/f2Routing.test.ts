// Block F2, over HTTP on a throwaway database: review by amount, the
// request that keeps everything the customer typed, the conversion that
// follows the normal price and crew rule, the US phone check, leads only
// when there is somebody to reach, the customer's own request list, the
// dismissal that says why, and the daily alert for a request left waiting.
// Twilio and the email webhook are stubbed. Every row made here is deleted at
// the end with counts, and the settings are put back.
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
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { runAsActor } from "../actor.js";
import { addDays } from "../automation/time.js";
import { serializeBid } from "../bids.js";
import { usPhoneDigits } from "../customerAuth.js";
import { prisma } from "../db.js";
import { leadContactFrom } from "../leadContact.js";
import { businessDaysBetween, findDueNotifications, runTimedNotifications } from "../notifications.js";
import { customerWriteGuard } from "../security.js";
import conciergeLeadsRouter from "../routes/conciergeLeads.js";
import customerRouter from "../routes/customer.js";
import designRequestsRouter from "../routes/designRequests.js";
import directBookingsRouter, { staffBookingRouter } from "../routes/directBookings.js";
import tierRouter from "../routes/tier.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("f2Routing.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const made = { items: [] as string[], customers: [] as string[], bookings: [] as string[], requests: [] as string[], packages: [] as string[], policies: [] as string[], statuses: [] as string[], crew: [] as string[] };
let settingsBefore: Record<string, unknown> | null = null;
let bar = "";
let tent = "";
let dj = "";
let hall = "";
let weddingPackage = "";

// Twilio and the email webhook: every send "works" and is remembered.
const emails: { to: string; subject: string; body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
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
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://store.test", "X-Forwarded-For": `10.8.${Math.floor(ipCount / 200)}.${ipCount % 200}` };
  if (init.cookie) headers.Cookie = init.cookie;
  const r = await realFetch(`${base}${path}`, { ...init, headers });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown>, cookie: set ? set.split(";")[0] : null };
}
const post = (path: string, body: unknown, cookie?: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const patch = (path: string, body: unknown, cookie?: string) => call(path, { method: "PATCH", body: JSON.stringify(body), cookie });
const get = (path: string, cookie?: string) => call(path, { cookie });
const day = (n: number) => addDays(new Date().toISOString().slice(0, 10), n);
let n = 0;
function holdBody(itemId: string, over: Record<string, unknown> = {}) {
  n += 1;
  return { itemId, eventDate: day(60 + n), eventTime: "2 PM", customerName: `${ZZ} Customer ${n}`, phone: `(860) 555-01${String(n).padStart(2, "0")}`, email: `zz-f2-${n}@example.test`, agreedToPolicy: true, delivery: null, ...over };
}
const track = (r: Res) => {
  if (typeof r.json.bookingId === "string") made.bookings.push(r.json.bookingId);
  if (typeof r.json.designRequestId === "string") made.requests.push(r.json.designRequestId);
  return r;
};
let signups = 0;
async function signUp(over: Record<string, unknown> = {}) {
  signups += 1;
  const r = await post("/api/customer/signup", { name: `${ZZ} Holder ${signups}`, phone: `860-555-02${String(signups).padStart(2, "0")}`, email: `zz-f2-holder-${signups}@example.test`, password: "a-long-enough-password", ...over });
  if (r.status === 201) made.customers.push((r.json.customer as { id: string }).id);
  return r;
}
const delivery = { placeId: "place-f2", formattedAddress: "14 Maple Ln, Avon, CT 06001, USA", components: { streetNumber: "14", route: "Maple Lane", city: "Avon", state: "CT", zip: "06001" }, addressLat: 41.8102, addressLng: -72.8309, setupLat: 41.8105, setupLng: -72.8301, setupNotes: "Backyard, gate on the left" };

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  settingsBefore = { reviewAmountKids: a.reviewAmountKids, reviewAmountAdult: a.reviewAmountAdult, reviewAmountWedding: a.reviewAmountWedding, reviewAmountCorporate: a.reviewAmountCorporate, reviewAmountDefault: a.reviewAmountDefault, requestResponseDays: a.requestResponseDays, contractRequiredOver: a.contractRequiredOver, contractRequiredForCrewed: a.contractRequiredForCrewed, requireAgreementCheckbox: a.requireAgreementCheckbox, requireCustomerAccount: a.requireCustomerAccount, directBookingDailyCap: a.directBookingDailyCap, requireBotCheck: a.requireBotCheck };
  // The rules as the owner set them.
  await prisma.account.update({ where: { id: accountId }, data: { reviewAmountKids: 10000, reviewAmountAdult: 10000, reviewAmountWedding: 5000, reviewAmountCorporate: 5000, reviewAmountDefault: 10000, requestResponseDays: 3, contractRequiredOver: 1000, contractRequiredForCrewed: true, requireAgreementCheckbox: false, requireCustomerAccount: false, directBookingDailyCap: 1000, requireBotCheck: false } });
  await prisma.customer.deleteMany({ where: { accountId, email: { startsWith: "zz-f2-" } } });
  if ((await prisma.leadStatus.count({ where: { accountId } })) === 0) made.statuses.push((await prisma.leadStatus.create({ data: { accountId, name: "New", position: 0 } })).id);
  const policy = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  if (!policy || policy.text.trim() === "") made.policies.push((await prisma.policyVersion.create({ data: { accountId, version: (policy?.version ?? 0) + 1, text: `${ZZ} rental policy: the retainer is {{depositPercentage}}% and non-refundable.` } })).id);
  const units = (labels: string[]) => ({ create: labels.map((label) => ({ label })) });
  const mk = async (name: string, category: string, price: number, extra: Record<string, unknown> = {}) => {
    const item = await prisma.item.create({ data: { accountId, name: `${ZZ} F2 ${name}`, category, price, units: units(["1", "2", "3", "4", "5", "6", "7", "8"]), ...extra } });
    made.items.push(item.id);
    return item.id;
  };
  bar = await mk("Portable Bar", "Bar and Cigar", 225);
  tent = await mk("Tent", "Tents", 4999);
  hall = await mk("Grand Setup", "Decor", 5000);
  // A crewed item priced so a corporate order lands just under the review amount.
  const crew = await prisma.crewMember.create({ data: { accountId, name: `${ZZ} F2 DJ Person`, phone: "8605550190", skills: ["DJ"], active: true } });
  made.crew.push(crew.id);
  const djItem = await prisma.item.create({ data: { accountId, name: `${ZZ} F2 DJ Set`, category: "DJ and MC", price: 4999, skills: ["DJ"] } });
  made.items.push(djItem.id);
  dj = djItem.id;
  const pkg = await prisma.package.create({ data: { accountId, name: `${ZZ} F2 Wedding Package`, price: 4999, status: "Published", occasions: ["Ceremony + reception"], items: { create: [{ itemId: tent, quantity: 1 }] } } });
  made.packages.push(pkg.id);
  weddingPackage = pkg.id;

  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/customer", customerWriteGuard);
  app.use("/api/bookings/direct", customerWriteGuard);
  app.use("/api/bookings/tier", customerWriteGuard);
  app.use(express.json({ limit: "64kb" }));
  const staff = (_req: express.Request, _res: express.Response, next: express.NextFunction) => runAsActor({ id: "zz-owner", name: "ZZ Owner", role: "Owner" }, () => next());
  app.use("/api/customer", customerRouter);
  app.use("/api/bookings/direct", directBookingsRouter);
  app.use("/api/bookings/tier", tierRouter);
  app.use("/api/bookings/staff", staff, staffBookingRouter);
  app.use("/api/design-requests", staff, designRequestsRouter);
  app.use("/api/leads/concierge", conciergeLeadsRouter);
  app.use(((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.log("[test] route threw:", err instanceof Error ? err.stack : String(err));
    res.status(500).json({ error: "test: route threw" });
  }) as express.ErrorRequestHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  const requestIds = (await prisma.designRequest.findMany({ where: { accountId, customerName: { startsWith: ZZ } }, select: { id: true } })).map((r) => r.id);
  const counts = {
    notifications: (await prisma.notification.deleteMany({ where: { accountId, OR: [{ body: { contains: ZZ } }, { dedupeKey: { startsWith: "design-request" } }] } })).count,
    messages: (await prisma.messageLog.deleteMany({ where: { accountId, OR: [{ bookingId: { in: made.bookings } }, { designRequestId: { in: requestIds } }] } })).count,
    requests: (await prisma.designRequest.deleteMany({ where: { id: { in: requestIds } } })).count,
    quotes: (await prisma.quote.deleteMany({ where: { accountId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } })).count,
    bookings: (await prisma.booking.deleteMany({ where: { accountId, customerName: { startsWith: ZZ } } })).count,
    leads: (await prisma.lead.deleteMany({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { contact: { contains: "zz-f2-" } }] } })).count,
    customers: (await prisma.customer.deleteMany({ where: { id: { in: made.customers } } })).count,
    packages: (await prisma.package.deleteMany({ where: { id: { in: made.packages } } })).count,
    items: (await prisma.item.deleteMany({ where: { id: { in: made.items } } })).count,
    crew: (await prisma.crewMember.deleteMany({ where: { id: { in: made.crew } } })).count,
    policies: (await prisma.policyVersion.deleteMany({ where: { id: { in: made.policies } } })).count,
    statuses: (await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } })).count,
  };
  if (settingsBefore) await prisma.account.update({ where: { id: accountId }, data: settingsBefore as object });
  console.log("cleanup", JSON.stringify(counts));
  await prisma.$disconnect();
});

// ---- 1. review by amount ----------------------------------------------------------------
test("a $225 rehearsal dinner checks out on the policy path, pays nothing to review, and still gets the wedding details", async () => {
  const s = await signUp();
  const cookie = s.cookie!;
  const t = await post("/api/bookings/tier", { itemId: bar, eventDate: day(40), occasion: "Rehearsal dinner" });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.equal(t.json.tier, 1);
  const h = track(await post("/api/bookings/direct", holdBody(bar, { occasion: "Rehearsal dinner", tier: 1, phone: undefined, email: undefined, customerName: undefined }), cookie));
  assert.equal(h.status, 201, JSON.stringify(h.json));
  assert.equal(h.json.tier, 1);
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: h.json.bookingId as string }, include: { units: true } });
  assert.equal(b.status, "Held");
  assert.equal(b.units.length, 1, "the unit is held");
  assert.equal(await prisma.designRequest.count({ where: { customerId: (s.json.customer as { id: string }).id } }), 0);
  // Item 2: a wedding on the policy path gets the wedding details form like any other.
  const w = await get(`/api/customer/bookings/${b.id}/wedding-details`, cookie);
  assert.equal(w.status, 200, JSON.stringify(w.json));
  assert.equal(w.json.status, "not_started");
});

test("a $4,999 wedding package and a $4,999 crewed corporate order take the contract path; $9,999 birthday too", async () => {
  const pkg = await post("/api/bookings/tier", { itemId: tent, packageId: weddingPackage, eventDate: day(41) });
  assert.equal(pkg.status, 200, JSON.stringify(pkg.json));
  assert.equal(pkg.json.tier, 2);
  assert.deepEqual(pkg.json.reasons, ["over-contract-threshold"]);
  assert.ok(pkg.json.contract, "the contract quote comes with it");
  const corp = await post("/api/bookings/tier", { itemId: dj, eventDate: day(42), occasion: "Team building" });
  assert.equal(corp.json.tier, 2, JSON.stringify(corp.json));
  assert.deepEqual(corp.json.reasons, ["over-contract-threshold", "crewed"]);
  await prisma.item.update({ where: { id: hall }, data: { price: 9999 } });
  const bday = await post("/api/bookings/tier", { itemId: hall, eventDate: day(43), occasion: "Birthday" });
  assert.equal(bday.json.tier, 2, JSON.stringify(bday.json));
  await prisma.item.update({ where: { id: hall }, data: { price: 10000 } });
  const big = await post("/api/bookings/tier", { itemId: hall, eventDate: day(43), occasion: "Birthday" });
  assert.equal(big.json.tier, 3, "a $10,000 birthday goes to review");
  assert.equal(big.json.responseDays, 3);
  assert.equal("reviewReason" in big.json, false, "the store is not told where the line is");
  await prisma.item.update({ where: { id: hall }, data: { price: 5000 } });
});

// ---- 3, 4, 7, 8: the request keeps everything, converts by the normal rule, and the customer can see it ----
test("a $5,000 wedding goes to review with everything the customer typed; converting carries it all onto a contract-path booking", async () => {
  const s = await signUp({ homeAddress: delivery.formattedAddress });
  const cookie = s.cookie!;
  const customerId = (s.json.customer as { id: string }).id;
  const eventDate = day(50);
  const r = track(await post("/api/bookings/direct", { itemId: hall, eventDate, eventTime: "4 PM", occasion: "Reception only", agreedToPolicy: true, delivery, address: delivery.formattedAddress, eventAddressSameAsHome: true, guestCount: 120 }, cookie));
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.reviewRequired, true);
  assert.equal(r.json.responseDays, 3);
  assert.equal("reviewReason" in r.json, false);
  const id = r.json.designRequestId as string;
  const row = await prisma.designRequest.findUniqueOrThrow({ where: { id } });
  assert.equal(row.reviewReason, "Wedding total is $5,000 or more");
  assert.deepEqual(row.reasons, ["threshold"]);
  assert.equal(row.placeId, "place-f2");
  assert.equal(row.address, "14 Maple Ln, Avon, CT 06001, USA");
  assert.equal(row.addressLat, 41.8102);
  assert.equal(row.setupLat, 41.8105);
  assert.equal(row.setupLng, -72.8301);
  assert.equal(row.setupNotes, "Backyard, gate on the left");
  assert.equal(row.eventAddressSameAsHome, true);
  assert.equal(row.guestCount, 120);
  assert.equal(await prisma.booking.count({ where: { customerId } }), 0, "nothing is held");

  // The customer sees it in their account.
  let mine = await get("/api/customer/requests", cookie);
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  assert.equal(mine.json.responseDays, 3);
  assert.equal(mine.json.promise, "We will contact you within 3 business days.");
  let req0 = (mine.json.requests as Record<string, unknown>[])[0];
  assert.equal(req0.status, "received");
  assert.equal(req0.statusLabel, "Received");
  assert.equal(req0.setupNotes, "Backyard, gate on the left");
  assert.equal(req0.address, "14 Maple Ln, Avon, CT 06001, USA");
  assert.equal(req0.guestCount, 120);
  assert.equal(req0.eventDate, eventDate);
  assert.deepEqual(req0.items, [{ name: `${ZZ} F2 Grand Setup`, quantity: 1 }]);
  assert.equal(req0.promise, "We will contact you within 3 business days.");
  for (const hidden of ["notes", "dismissReason", "reviewReason", "phone", "email"]) assert.equal(hidden in req0, false, `${hidden} stays with staff`);
  assert.equal((await get("/api/customer/requests")).status, 401, "signed in only");

  // Staff see it all on the request, with the specific reason; a saved note reads as "being reviewed".
  const list = await get("/api/design-requests?status=Open");
  const card = (list.json as unknown as Record<string, unknown>[]).find((x) => x.id === id)!;
  assert.equal(card.reviewReason, "Wedding total is $5,000 or more");
  assert.equal(card.setupNotes, "Backyard, gate on the left");
  assert.match(String(card.mapsUrl), /query_place_id=place-f2$/);
  await patch(`/api/design-requests/${id}`, { notes: "Called, quoting Friday" });
  mine = await get("/api/customer/requests", cookie);
  assert.equal((mine.json.requests as Record<string, unknown>[])[0].status, "being-reviewed");

  // Convert: the same price and crew rule as any booking. $5,000 is over $1,000, so the contract path.
  const bellBefore = await prisma.notification.count({ where: { dedupeKey: `design-request:${id}`, readAt: null } });
  assert.equal(bellBefore, 1);
  const c = track(await post("/api/bookings/staff", { designRequestId: id, customerId, customerName: `${ZZ} Holder`, itemIds: [hall], eventDate, eventTime: "4 PM", address: row.address, occasion: "Reception only", agreed: true }));
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(c.json.tier, 2);
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: c.json.bookingId as string } });
  assert.equal(b.setupNotes, "Backyard, gate on the left", "the setup notes came along");
  assert.equal(b.setupLat, 41.8105, "and the pin");
  assert.equal(b.setupLng, -72.8301);
  assert.equal(b.placeId, "place-f2");
  assert.equal(b.addressLat, 41.8102);
  assert.equal(b.addressCheck, "verified");
  assert.equal(b.eventAddressSameAsHome, true);
  assert.equal(b.guestCount, 120);
  assert.equal(b.occasion, "Reception only");
  await new Promise((r2) => setTimeout(r2, 500));
  assert.equal(await prisma.notification.count({ where: { dedupeKey: `design-request:${id}`, readAt: null } }), 0, "the bell alert is cleared");
  const sent = await prisma.messageLog.findMany({ where: { bookingId: b.id, triggerKey: "contract_sent" } });
  assert.ok(sent.length > 0, "the contract path sends the contract link");
  mine = await get("/api/customer/requests", cookie);
  req0 = (mine.json.requests as Record<string, unknown>[])[0];
  assert.equal(req0.status, "booked");
  assert.equal(req0.bookingId, b.id);
  assert.equal(req0.promise, null);
  // The crew member who holds a gig on this booking would read the setup notes.
  const page = serializeBid({ status: "Accepted", bidAmount: 300, bidNote: null, bidSubmittedAt: new Date(), deadlineAt: null, createdAt: new Date(), confirmedAt: null, crewMember: { name: "Alex Doe" }, questions: [], gig: { skill: "DJ", eventType: null, guestCount: null, eventDate: new Date(), startTime: null, endTime: null, town: null, payMin: null, payMax: null, status: "Filled", arrivalNotes: null, booking: { address: b.address, eventTime: b.eventTime, setupLat: b.setupLat, setupLng: b.setupLng, setupNotes: b.setupNotes, placeId: b.placeId, addressLat: b.addressLat, addressLng: b.addressLng } } } as unknown as Parameters<typeof serializeBid>[0], new Date(), "+18605550100");
  assert.equal(page.setupNotes, "Backyard, gate on the left");
});

test("a request converted at a small price takes the policy path: no contract is sent", async () => {
  // Staff lower the price on the call: $5,000 was reviewed, $800 is booked.
  const s = await signUp();
  const cookie = s.cookie!;
  const customerId = (s.json.customer as { id: string }).id;
  const eventDate = day(55);
  const r = track(await post("/api/bookings/direct", { itemId: hall, eventDate, occasion: "Holiday party", agreedToPolicy: true, delivery: null, address: null }, cookie));
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const row = await prisma.designRequest.findUniqueOrThrow({ where: { id: r.json.designRequestId as string } });
  assert.equal(row.reviewReason, "Corporate total is $5,000 or more");
  const c = track(await post("/api/bookings/staff", { designRequestId: row.id, customerId, customerName: `${ZZ} Holder`, itemIds: [hall], eventDate, occasion: "Holiday party", total: 800, agreed: true }));
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(c.json.tier, 1, "$800 with no crew is the policy path");
  await new Promise((r2) => setTimeout(r2, 400));
  assert.equal(await prisma.messageLog.count({ where: { bookingId: c.json.bookingId as string } }), 0, "nothing is sent on the policy path");
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: c.json.bookingId as string } });
  assert.equal(b.status, "Held");
});

// ---- 5. the phone check ---------------------------------------------------------------------
test("phone: the store must send a real US number; staff entry is never blocked", async () => {
  for (const bad of ["1111111111", "0605550142", "8600550142", "860555014", "86055501422", "+44 20 7946 0958"]) assert.equal(usPhoneDigits(bad), null, bad);
  for (const [good, digits] of [["(860) 555-0142", "8605550142"], ["+1 860 555 0142", "8605550142"], ["8605550142", "8605550142"]] as const) assert.equal(usPhoneDigits(good), digits);
  const su = await signUp({ phone: "1111111111" });
  assert.equal(su.status, 400);
  assert.equal(su.json.reason, "phone-invalid");
  assert.equal(su.json.field, "phone");
  const ok = await signUp({ phone: "+1 (860) 555-0299" });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((ok.json.customer as { phone: string }).phone, "8605550299", "stored as ten digits");
  const login = await post("/api/customer/login", { identifier: "860-555-0299", password: "a-long-enough-password" });
  assert.equal(login.status, 200, "sign in by the same phone, typed another way");
  const me = await patch("/api/customer/me", { phone: "2222222222" }, ok.cookie!);
  assert.equal(me.status, 400);
  assert.equal(me.json.reason, "phone-invalid");
  // A hold from the store with a made-up number is refused before anything is held.
  const h = await post("/api/bookings/direct", holdBody(bar, { phone: "1111111111" }));
  assert.equal(h.status, 400);
  assert.equal(h.json.reason, "phone-invalid");
  assert.equal(h.json.field, "phone");
  // A request (an order that would go to review) is held to the same rule.
  const rq = await post("/api/bookings/direct", holdBody(hall, { phone: "1111111111", occasion: "Reception only" }));
  assert.equal(rq.status, 400);
  assert.equal(rq.json.reason, "phone-invalid");
  // Staff can type whatever the customer gave them.
  const st = track(await post("/api/bookings/staff", { customerName: `${ZZ} Staff Phone`, phone: "1111111111", email: "zz-f2-staff@example.test", itemIds: [bar], eventDate: day(70), agreed: true }));
  assert.equal(st.status, 201, JSON.stringify(st.json));
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: st.json.bookingId as string } })).phone, "1111111111");
});

// ---- 6. leads only when there is somebody to reach --------------------------------------------
test("leads: Talk to us and Ask GO make a lead only with a name, an email or a phone", async () => {
  const none = await post("/api/leads/concierge", { source: "ask_go", occasion: "Birthday" });
  assert.equal(none.status, 200);
  assert.equal(none.json.leadId, null);
  const partial = await post("/api/leads/concierge", { source: "checkout", occasion: "Birthday", phone: "860 555 0177" });
  assert.equal(partial.status, 201, JSON.stringify(partial.json));
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: partial.json.leadId as string } });
  assert.equal(lead.customerName, null, "a partial lead is kept as it is");
  assert.equal(lead.contact, "860 555 0177");
  await prisma.lead.delete({ where: { id: lead.id } });
  const fake = (cookie?: string) => ({ signedCookies: {}, cookies: {}, headers: cookie ? { cookie } : {} }) as unknown as express.Request;
  assert.equal(await leadContactFrom(fake(), {}), null, "a chat with none of the three makes no lead");
  assert.deepEqual(await leadContactFrom(fake(), { name: "  Sam  " }), { name: "Sam", phone: null, email: null });
  assert.deepEqual(await leadContactFrom(fake(), { email: "not-an-email", phone: "12" }), null);
  assert.deepEqual(await leadContactFrom(fake(), { email: "zz-f2-lead@example.test" }), { name: null, phone: null, email: "zz-f2-lead@example.test" });
});

// ---- 8. dismiss says why, and can tell the customer ---------------------------------------------
test("dismiss needs a reason, can email the customer, clears the bell, and reads as closed to the customer", async () => {
  const s = await signUp();
  const cookie = s.cookie!;
  const r = track(await post("/api/bookings/direct", { itemId: hall, eventDate: day(58), occasion: "Product launch", agreedToPolicy: true, delivery: null }, cookie));
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const id = r.json.designRequestId as string;
  const noReason = await patch(`/api/design-requests/${id}`, { status: "Dismissed" });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.reason, "reason-required");
  emails.length = 0;
  const quiet = await patch(`/api/design-requests/${id}`, { status: "Dismissed", reason: "Outside our area" });
  assert.equal(quiet.status, 200, JSON.stringify(quiet.json));
  assert.equal(quiet.json.dismissReason, "Outside our area");
  assert.equal(quiet.json.dismissedByName, "ZZ Owner");
  assert.equal("customerTold" in quiet.json, false);
  assert.equal(emails.length, 0, "not ticked, not sent");
  assert.equal(await prisma.notification.count({ where: { dedupeKey: `design-request:${id}`, readAt: null } }), 0, "the bell alert is cleared");
  let mine = await get("/api/customer/requests", cookie);
  assert.equal((mine.json.requests as Record<string, unknown>[])[0].status, "closed");
  assert.equal((mine.json.requests as Record<string, unknown>[])[0].promise, null);
  // Reopen, then dismiss and tell the customer.
  assert.equal((await patch(`/api/design-requests/${id}`, { status: "Open" })).status, 200);
  const told = await patch(`/api/design-requests/${id}`, { status: "Dismissed", reason: "Date not available", tellCustomer: true });
  assert.equal(told.status, 200, JSON.stringify(told.json));
  assert.deepEqual(told.json.customerTold, { sent: true, why: null });
  assert.ok(told.json.customerToldAt);
  const log = await prisma.messageLog.findMany({ where: { designRequestId: id, triggerKey: "design_request_closed" } });
  assert.equal(log.length, 1);
  assert.equal(log[0].channel, "email");
  assert.equal(log[0].status, "sent");
  assert.match(log[0].body, /we have closed it\. Nothing was held and nothing was charged\./);
  assert.ok(!log[0].body.includes("Date not available"), "the staff reason never goes to the customer");
  mine = await get("/api/customer/requests", cookie);
  assert.equal("dismissReason" in (mine.json.requests as Record<string, unknown>[])[0], false);
});

// ---- 9. requests do not sit -------------------------------------------------------------------
test("a request still open after the promised business days raises an alert every day until it is handled", async () => {
  assert.equal(businessDaysBetween("2026-11-06", "2026-11-09"), 1, "Friday to Monday is one business day");
  assert.equal(businessDaysBetween("2026-11-09", "2026-11-12"), 3);
  assert.equal(businessDaysBetween("2026-11-09", "2026-11-09"), 0);
  const s = await signUp();
  const r = track(await post("/api/bookings/direct", { itemId: hall, eventDate: day(80), occasion: "Grand opening", agreedToPolicy: true, delivery: null }, s.cookie!));
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const id = r.json.designRequestId as string;
  // Monday Nov 9 2026: made that day, so nothing is overdue on Wed Nov 11 (2 business days), and it is on Thu Nov 12 (3).
  await prisma.designRequest.update({ where: { id }, data: { createdAt: new Date("2026-11-09T15:00:00Z") } });
  const wed = new Date("2026-11-11T15:00:00Z");
  const thu = new Date("2026-11-12T15:00:00Z");
  const fri = new Date("2026-11-13T15:00:00Z");
  const overdue = async (now: Date) => (await findDueNotifications(now)).filter((x) => x.type === "design-request-overdue" && x.dedupeKey.includes(id));
  assert.equal((await overdue(wed)).length, 0);
  const due = await overdue(thu);
  assert.equal(due.length, 1);
  assert.equal(due[0].title, "Request still waiting");
  assert.match(due[0].body, /Open 3 business days; the customer was told 3\./);
  await runTimedNotifications(thu);
  await runTimedNotifications(thu);
  await runTimedNotifications(fri);
  const rows = await prisma.notification.findMany({ where: { type: "design-request-overdue", dedupeKey: { contains: id } }, orderBy: { createdAt: "asc" } });
  assert.equal(rows.length, 2, "once on Thursday, once more on Friday");
  // Handled: the alerts are cleared and no more are raised.
  const done = await patch(`/api/design-requests/${id}`, { status: "Dismissed", reason: "Duplicate" });
  assert.equal(done.status, 200);
  assert.equal(await prisma.notification.count({ where: { dedupeKey: { contains: id }, readAt: null } }), 0);
  assert.equal((await overdue(new Date("2026-11-16T15:00:00Z"))).length, 0);
});
