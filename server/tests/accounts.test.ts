// Block A5, over HTTP on a throwaway database: the "Require an account to
// book" switch on the storefront hold, the customer's home address on sign
// up, profile update and the hold, and the balance due days published to
// the storefront and printed in the contract. Twilio is stubbed. Every row
// made here is deleted at the end with counts, and the settings put back.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.STOREFRONT_URL = "https://store.test";
process.env.PUBLIC_API_URL = "https://api.test";
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "https://store.test";
delete process.env.EMAIL_WEBHOOK_URL;
delete process.env.STRIPE_SECRET_KEY;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { addDays } from "../automation/time.js";
import { prisma } from "../db.js";
import { customerWriteGuard } from "../security.js";
import customerRouter from "../routes/customer.js";
import directBookingsRouter from "../routes/directBookings.js";
import { publicSettingsRouter } from "../routes/settings.js";
import tierRouter from "../routes/tier.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("accounts.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const made = { items: [] as string[], customers: [] as string[], bookings: [] as string[], quotes: [] as string[], statuses: [] as string[] };
let settingsBefore: Record<string, unknown> | null = null;
let small = "";
let big = "";

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
  return realFetch(input, init);
}) as typeof fetch;

type Res = { status: number; json: Record<string, unknown>; cookie: string | null };
async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://store.test" };
  if (init.cookie) headers.Cookie = init.cookie;
  const r = await realFetch(`${base}${path}`, { ...init, headers });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown>, cookie: set ? set.split(";")[0] : null };
}
const post = (path: string, body: unknown, cookie?: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const patch = (path: string, body: unknown, cookie?: string) => call(path, { method: "PATCH", body: JSON.stringify(body), cookie });
const get = (path: string, cookie?: string) => call(path, { cookie });
const day = (n: number) => addDays(new Date().toISOString().slice(0, 10), n);
let holdCount = 0;
function holdBody(itemId: string, over: Record<string, unknown> = {}) {
  holdCount += 1;
  return { itemId, eventDate: day(60 + holdCount), eventTime: "2 PM", customerName: `${ZZ} Customer ${holdCount}`, phone: `+150055502${String(holdCount).padStart(2, "0")}`, email: `zz-a5-${holdCount}@example.test`, agreedToPolicy: true, delivery: null, address: "9 Event Rd, Avon, CT 06001", ...over };
}
const track = (r: Res) => {
  if (typeof r.json.bookingId === "string") made.bookings.push(r.json.bookingId);
  return r;
};
let signupCount = 0;
async function signUp(over: Record<string, unknown> = {}) {
  signupCount += 1;
  const r = await post("/api/customer/signup", { name: `${ZZ} Holder ${signupCount}`, phone: `+150055509${String(signupCount).padStart(2, "0")}`, email: `zz-a5-holder-${signupCount}@example.test`, password: "a-long-enough-password", ...over });
  const c = r.json.customer as { id: string } | undefined;
  if (c?.id) made.customers.push(c.id);
  return r;
}
const requireAccount = (on: boolean) => prisma.account.update({ where: { id: accountId }, data: { requireCustomerAccount: on } });

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  settingsBefore = { requireCustomerAccount: a.requireCustomerAccount, balanceDueDays: a.balanceDueDays, contractRequiredOver: a.contractRequiredOver, fullReviewThreshold: a.fullReviewThreshold, reviewOccasions: a.reviewOccasions, authorizedSignerName: a.authorizedSignerName, authorizedSignerTitle: a.authorizedSignerTitle, directBookingDailyCap: a.directBookingDailyCap };
  await prisma.account.update({ where: { id: accountId }, data: { requireCustomerAccount: false, balanceDueDays: 30, contractRequiredOver: 1000, fullReviewThreshold: 15000, reviewOccasions: ["Wedding"], authorizedSignerName: "Mel Owner", authorizedSignerTitle: "Owner", directBookingDailyCap: 1000 } });
  if ((await prisma.leadStatus.count({ where: { accountId } })) === 0) {
    const s = await prisma.leadStatus.create({ data: { accountId, name: "New", position: 0 } });
    made.statuses.push(s.id);
  }
  const policy = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  if (!policy || policy.text.trim() === "") await prisma.policyVersion.create({ data: { accountId, version: (policy?.version ?? 0) + 1, text: `${ZZ} rental policy: the retainer is {{depositPercentage}}% and non-refundable.` } });
  const s = await prisma.item.create({ data: { accountId, name: `${ZZ} Cotton Candy Cart`, category: "Food", price: 300, priceUnit: "per day", units: { create: [{ label: "Cart 1" }, { label: "Cart 2" }, { label: "Cart 3" }, { label: "Cart 4" }, { label: "Cart 5" }] } } });
  const b = await prisma.item.create({ data: { accountId, name: `${ZZ} Big Tent`, category: "Tents", price: 2500, priceUnit: "per event", units: { create: [{ label: "Tent A" }] } } });
  made.items.push(s.id, b.id);
  small = s.id;
  big = b.id;

  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/customer", customerWriteGuard);
  app.use("/api/bookings/direct", customerWriteGuard);
  app.use("/api/bookings/tier", customerWriteGuard);
  app.use(express.json({ limit: "50kb" }));
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/settings", publicSettingsRouter);
  app.use("/api/bookings/direct", directBookingsRouter);
  app.use("/api/bookings/tier", tierRouter);
  app.use("/api/customer", customerRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  globalThis.fetch = realFetch;
  const logs = await prisma.messageLog.deleteMany({ where: { OR: [{ bookingId: { in: made.bookings } }, { recipient: { startsWith: "+1500555" } }] } });
  const b = await prisma.booking.deleteMany({ where: { id: { in: made.bookings } } });
  const l = await prisma.lead.deleteMany({ where: { customerName: { startsWith: ZZ } } });
  const q = await prisma.quote.deleteMany({ where: { id: { in: made.quotes } } });
  const c = await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
  const i = await prisma.item.deleteMany({ where: { id: { in: made.items } } });
  const st = await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } });
  if (settingsBefore) await prisma.account.update({ where: { id: accountId }, data: settingsBefore as object });
  const left = { bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }), items: await prisma.item.count({ where: { name: { startsWith: ZZ } } }), customers: await prisma.customer.count({ where: { email: { contains: "zz-a5-" } } }) };
  console.log(`# cleanup: ${b.count} bookings, ${l.count} leads, ${q.count} quotes, ${c.count} customers, ${i.count} items, ${st.count} lead columns, ${logs.count} message logs; remaining ${JSON.stringify(left)}`);
  await prisma.$disconnect();
});

test("public settings carry balanceDueDays and requireCustomerAccount, and the contract prints the same number", async () => {
  let s = await get("/api/settings/public");
  assert.equal(s.status, 200);
  assert.equal(s.json.balanceDueDays, 30);
  assert.equal(s.json.requireCustomerAccount, false);
  for (const key of ["fullReviewThreshold", "reviewOccasions", "directBookingDailyCap"]) assert.equal(key in s.json, false, `${key} stays internal`);

  await prisma.account.update({ where: { id: accountId }, data: { balanceDueDays: 21 } });
  s = await get("/api/settings/public");
  assert.equal(s.json.balanceDueDays, 21);
  const t = await post("/api/bookings/tier", { itemId: big, eventDate: day(90), eventTime: "2 PM" });
  assert.equal(t.json.tier, 2);
  const q = t.json.contract as { quoteId: string; document: unknown };
  made.quotes.push(q.quoteId);
  const text = JSON.stringify(q.document);
  assert.match(text, /is due in full 21 days prior to the contracted event date/);
  assert.match(text, /is due 21 days prior to the event/);
  assert.doesNotMatch(text, /30 days prior/);
  await prisma.account.update({ where: { id: accountId }, data: { balanceDueDays: 30 } });
});

test("sign up takes a home address, the profile shows it, and the profile update changes name, phone and home address but never email", async () => {
  const r = await signUp({ homeAddress: "  12 Home St, Avon, CT 06001 " });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const c = r.json.customer as Record<string, unknown>;
  assert.equal(c.homeAddress, "12 Home St, Avon, CT 06001");
  assert.equal("passwordHash" in c, false);
  const cookie = r.cookie as string;

  let me = await get("/api/customer/me", cookie);
  assert.equal((me.json.customer as Record<string, unknown>).homeAddress, "12 Home St, Avon, CT 06001");

  let p = await patch("/api/customer/me", { name: `${ZZ} Renamed`, phone: "(860) 555-0177", homeAddress: "40 New Rd, Avon, CT 06001" }, cookie);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const after = p.json.customer as Record<string, unknown>;
  assert.equal(after.name, `${ZZ} Renamed`);
  assert.equal(after.phone, "8605550177");
  assert.equal(after.homeAddress, "40 New Rd, Avon, CT 06001");
  me = await get("/api/customer/me", cookie);
  assert.equal((me.json.customer as Record<string, unknown>).phone, "8605550177");

  p = await patch("/api/customer/me", { homeAddress: "" }, cookie);
  assert.equal(p.status, 200);
  assert.equal((p.json.customer as Record<string, unknown>).homeAddress, null, "blank clears it");
  p = await patch("/api/customer/me", { homeAddress: "x".repeat(301) }, cookie);
  assert.equal(p.status, 400);
  p = await patch("/api/customer/me", { email: "other@example.test" }, cookie);
  assert.equal(p.status, 400);
  p = await patch("/api/customer/me", {}, cookie);
  assert.equal(p.status, 400);
  p = await patch("/api/customer/me", { name: "Nobody" });
  assert.equal(p.status, 401, "no session");

  // A phone another account holds is refused.
  const other = await signUp();
  assert.equal(other.status, 201);
  p = await patch("/api/customer/me", { phone: (other.json.customer as Record<string, string>).phone }, cookie);
  assert.equal(p.status, 409);
  assert.equal(p.json.field, "phone");

  // A bad home address at sign-up is refused; a sign-up without one is fine.
  const bad = await signUp({ homeAddress: 12 });
  assert.equal(bad.status, 400);
  const none = await signUp();
  assert.equal(none.status, 201);
  assert.equal((none.json.customer as Record<string, unknown>).homeAddress, null);
});

test("setting off: a guest hold works as before and attaches to nobody", async () => {
  await requireAccount(false);
  const r = track(await post("/api/bookings/direct", holdBody(small)));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: r.json.bookingId as string } });
  assert.equal(b.customerId, null);
  assert.equal(b.eventAddressSameAsHome, false);
});

test("setting on: a guest hold is refused with 401 account-required; a signed-in hold works, is attached to the customer and fills the home address", async () => {
  await requireAccount(true);
  const guest = track(await post("/api/bookings/direct", holdBody(small)));
  assert.equal(guest.status, 401);
  assert.deepEqual(guest.json, { error: "Please sign in or create an account to book.", reason: "account-required" });
  assert.equal(await prisma.booking.count({ where: { customerName: { startsWith: `${ZZ} Customer` } } }), 1, "nothing new was written");
  const s = await get("/api/settings/public");
  assert.equal(s.json.requireCustomerAccount, true);

  const signup = await signUp();
  assert.equal(signup.status, 201);
  const cookie = signup.cookie as string;
  const customerId = (signup.json.customer as Record<string, string>).id;
  const r = track(await post("/api/bookings/direct", holdBody(small, { homeAddress: "9 Event Rd, Avon, CT 06001", eventAddressSameAsHome: true }), cookie));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: r.json.bookingId as string } });
  assert.equal(b.customerId, customerId);
  assert.equal(b.eventAddressSameAsHome, true);
  assert.equal(b.address, "9 Event Rd, Avon, CT 06001", "the event address is untouched");
  let c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(c.homeAddress, "9 Event Rd, Avon, CT 06001", "saved to the account that had none");

  // A later hold with a different home address never overwrites the one on file.
  const r2 = track(await post("/api/bookings/direct", holdBody(small, { homeAddress: "1 Other Pl, Avon, CT" }), cookie));
  assert.equal(r2.status, 201, JSON.stringify(r2.json));
  c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(c.homeAddress, "9 Event Rd, Avon, CT 06001");
  const b2 = await prisma.booking.findUniqueOrThrow({ where: { id: r2.json.bookingId as string } });
  assert.equal(b2.eventAddressSameAsHome, false, "absent means false");

  const bad = await post("/api/bookings/direct", holdBody(small, { eventAddressSameAsHome: "yes" }), cookie);
  assert.equal(bad.status, 400);

  // Off again: the next guest hold goes through.
  await requireAccount(false);
  const again = track(await post("/api/bookings/direct", holdBody(small)));
  assert.equal(again.status, 201, JSON.stringify(again.json));
});
