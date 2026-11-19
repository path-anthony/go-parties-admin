// Block FIX1b. Line prices for the store and the retainer figure. First the
// line rules with no database, then over HTTP on a throwaway database: My
// party's bookings, the pay link and the customer's requests carry every line
// with how it is priced, and {{depositAmount}} and the older contract's
// retainer line show what the booking actually owes. Twilio, email and
// Stripe are stubbed.
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
import { buildContractContent } from "../contracts.js";
import { prisma } from "../db.js";
import { bookingLineDetail, pricingKind, requestLineDetail } from "../lineDetail.js";
import { buildMessageValues } from "../messageContext.js";
import { customerWriteGuard } from "../security.js";
import customerRouter from "../routes/customer.js";
import directBookingsRouter from "../routes/directBookings.js";
import { payApiRouter } from "../routes/pay.js";
import tierRouter from "../routes/tier.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("fix1bLines.test.ts runs only against a throwaway database (name containing zz_scratch)");

// ---- the line rules, with no database ----------------------------------------------

describe("lines as a customer reads them", () => {
  test("pricing kinds in words", () => {
    assert.deepEqual(["per guest", "Per Person", "per 10 guests", "per day", "Per event", null, ""].map(pricingKind), ["per guest", "per guest", "per 10 guests", "per day", "per event", "each", "each"]);
  });
  test("a per-guest line reads its guest count, never 1; units count; crew-only items count by gigs; options are in the line", () => {
    const lines = bookingLineDetail({
      guestCount: 100,
      inPackage: false,
      units: [
        { item: { id: "chair", name: "Gold Chair", price: "8", priceUnit: "each" } },
        { item: { id: "chair", name: "Gold Chair", price: "8", priceUnit: "each" } },
        { item: { id: "chair", name: "Gold Chair", price: "8", priceUnit: "each" } },
        { item: { id: "bar", name: "Bar Package", price: "46", priceUnit: "per guest" } },
      ],
      crewOnly: [{ itemId: "dj", name: "DJ", price: "600", priceUnit: "per event", gigs: 2, skills: 2 }],
      lines: [{ itemId: "spread", itemName: "Mediterranean Spread", quantity: 1, guests: 100, perGuest: true, unitPrice: "58.56", lineTotal: "5856" }],
      options: [{ itemId: "chair", priceDelta: "2", quantity: 3 }],
    });
    const by = Object.fromEntries(lines.map((l) => [l.itemId, l]));
    assert.deepEqual([by.chair.kind, by.chair.quantity, by.chair.unitPrice, by.chair.optionsTotal, by.chair.lineTotal], ["each", 3, 8, 6, 30]);
    assert.deepEqual([by.bar.kind, by.bar.perGuest, by.bar.quantity, by.bar.guests, by.bar.lineTotal], ["per guest", true, 100, 100, 4600], "a per-guest item held by a unit");
    assert.deepEqual([by.dj.kind, by.dj.quantity, by.dj.lineTotal], ["per event", 1, 600]);
    assert.deepEqual([by.spread.kind, by.spread.quantity, by.spread.guests, by.spread.unitPrice, by.spread.lineTotal], ["per guest", 100, 100, 58.56, 5856], "a no-unit line");
  });
  test("a package's items have no price of their own", () => {
    const [l] = bookingLineDetail({ guestCount: null, inPackage: true, units: [{ item: { id: "t", name: "Tent", price: "400", priceUnit: "per day" } }], crewOnly: [], lines: [], options: [] });
    assert.deepEqual([l.kind, l.unitPrice, l.lineTotal], ["in package", null, null]);
  });
  test("a request's cart, new and old", () => {
    const units = new Map([["spread", "per guest"], ["chair", "each"], ["cigars", "per 10 guests"]]);
    const fresh = requestLineDetail({ items: [{ itemId: "spread", name: "Spread", quantity: 1, price: 58.56, perGuest: true, guests: 100, lineTotal: 5856 }, { itemId: "cigars", name: "Cigars", quantity: 2, price: 500, lineTotal: 1000 }] }, 100, units);
    assert.deepEqual(fresh.map((l) => [l.kind, l.quantity, l.lineTotal]), [["per guest", 100, 5856], ["per 10 guests", 2, 1000]]);
    const old = requestLineDetail({ items: [{ itemId: "chair", name: "Chair", quantity: 4, price: 8 }, { itemId: "spread", name: "Spread", quantity: 1, price: 58.56 }], addons: [{ itemId: "chair", priceDelta: 1, quantity: 4 }] }, 50, units);
    assert.deepEqual(old.map((l) => [l.kind, l.quantity, l.optionsTotal, l.lineTotal]), [["each", 4, 4, 36], ["per guest", 50, 0, 2928]]);
  });
});

// ---- over HTTP, on a throwaway database -------------------------------------------
const ZZ = "ZZFIXB";
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let settingsBefore: Record<string, unknown> | null = null;
const made = { items: [] as string[], customers: [] as string[], policies: [] as string[], statuses: [] as string[] };
let spread = "";
let chair = "";
let hall = "";
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
  if (url.startsWith("http://stub.invalid/")) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  return realFetch(input, init);
}) as typeof fetch;
let ip = 0;
async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  ip += 1;
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://store.test", "X-Forwarded-For": `10.11.${Math.floor(ip / 200)}.${ip % 200}` };
  if (init.cookie) headers.Cookie = init.cookie;
  const r = await realFetch(`${base}${path}`, { ...init, headers });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown>, cookie: set ? set.split(";")[0] : null };
}
const post = (path: string, body: unknown, cookie?: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
type Line = { itemId: string; name: string; kind: string; perGuest: boolean; quantity: number; guests: number | null; unitPrice: number | null; lineTotal: number | null };

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  settingsBefore = { reviewAmountKids: a.reviewAmountKids, reviewAmountAdult: a.reviewAmountAdult, reviewAmountWedding: a.reviewAmountWedding, reviewAmountCorporate: a.reviewAmountCorporate, reviewAmountDefault: a.reviewAmountDefault, contractRequiredOver: a.contractRequiredOver, contractRequiredForCrewed: a.contractRequiredForCrewed, requireAgreementCheckbox: a.requireAgreementCheckbox, requireCustomerAccount: a.requireCustomerAccount, directBookingDailyCap: a.directBookingDailyCap, requireBotCheck: a.requireBotCheck, depositPercentage: a.depositPercentage, tier1Collect: a.tier1Collect, useGoContract: a.useGoContract };
  await prisma.account.update({ where: { id: accountId }, data: { reviewAmountKids: 100000, reviewAmountAdult: 100000, reviewAmountWedding: 100000, reviewAmountCorporate: 100000, reviewAmountDefault: 9000, contractRequiredOver: 10000, contractRequiredForCrewed: true, requireAgreementCheckbox: false, requireCustomerAccount: false, directBookingDailyCap: 1000, requireBotCheck: false, depositPercentage: 20, tier1Collect: "retainer", useGoContract: true } });
  for (const [i, name] of ["New", "Contacted", "Booked", "Lost"].entries()) {
    if ((await prisma.leadStatus.count({ where: { accountId, name } })) === 0) made.statuses.push((await prisma.leadStatus.create({ data: { accountId, name, position: i } })).id);
  }
  const last = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  made.policies.push((await prisma.policyVersion.create({ data: { accountId, version: (last?.version ?? 0) + 1, text: `${ZZ} policy. A retainer of {{retainerPercent}}% holds the date.` } })).id);
  const mk = async (name: string, price: number, priceUnit: string, units: number) => {
    const item = await prisma.item.create({ data: { accountId, name: `${ZZ} ${name}`, category: "Catering", price, priceUnit, units: { create: Array.from({ length: units }, (_, i) => ({ label: String(i + 1) })) } } });
    made.items.push(item.id);
    return item.id;
  };
  spread = await mk("Mediterranean Spread", 58.56, "per guest", 1);
  chair = await mk("Gold Chair", 8, "each", 10);
  hall = await mk("Grand Tent", 9500, "per day", 3);

  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/customer", customerWriteGuard);
  app.use("/api/bookings/direct", customerWriteGuard);
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/customer", customerRouter);
  app.use("/api/bookings/direct", directBookingsRouter);
  app.use("/api/bookings/tier", tierRouter);
  app.use("/api/pay", payApiRouter);
  app.use(((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.log("[test] route threw:", err instanceof Error ? err.stack : String(err));
    res.status(500).json({ error: "test: route threw" });
  }) as express.ErrorRequestHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  globalThis.fetch = realFetch;
  const bookingIds = (await prisma.booking.findMany({ where: { accountId, customerName: { startsWith: ZZ } }, select: { id: true } })).map((b) => b.id);
  const counts = {
    messages: (await prisma.messageLog.deleteMany({ where: { bookingId: { in: bookingIds } } })).count,
    notifications: (await prisma.notification.deleteMany({ where: { OR: [{ bookingId: { in: bookingIds } }, { body: { contains: ZZ } }, { title: { contains: ZZ } }] } })).count,
    requests: (await prisma.designRequest.deleteMany({ where: { customerName: { startsWith: ZZ } } })).count,
    bookings: (await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } })).count,
    leads: (await prisma.lead.deleteMany({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { contact: { contains: "zz-fixb-" } }] } })).count,
    customers: (await prisma.customer.deleteMany({ where: { id: { in: made.customers } } })).count,
    items: (await prisma.item.deleteMany({ where: { id: { in: made.items } } })).count,
    policies: (await prisma.policyVersion.deleteMany({ where: { id: { in: made.policies } } }).catch(() => ({ count: -1 }))).count,
    statuses: (await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } }).catch(() => ({ count: -1 }))).count,
  };
  if (settingsBefore) await prisma.account.update({ where: { id: accountId }, data: settingsBefore as object });
  console.log("cleanup", JSON.stringify(counts), "remaining", JSON.stringify({ bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }), items: await prisma.item.count({ where: { name: { startsWith: ZZ } } }) }));
  await prisma.$disconnect();
});

let cookie = "";
let bookingId = "";

test("My party: every line, the no-unit one included, with kind, quantity, guests, unit price and line total", async () => {
  const s = await post("/api/customer/signup", { name: `${ZZ} Customer`, phone: "860-555-0731", email: "zz-fixb-1@example.test", password: "a-long-enough-password" });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  made.customers.push((s.json.customer as { id: string }).id);
  cookie = s.cookie as string;
  const h = await post("/api/bookings/direct", { itemIds: [spread, chair], quantities: { [chair]: 3 }, guestCount: 100, eventDate: day(70), eventTime: "2 PM", agreedToPolicy: true, delivery: null, tier: 1 }, cookie);
  assert.equal(h.status, 201, JSON.stringify(h.json));
  bookingId = h.json.bookingId as string;
  assert.equal(h.json.total, 5880);
  const mine = ((await call("/api/customer/bookings", { cookie })).json as unknown as { id: string; lines: Line[] }[]).find((b) => b.id === bookingId)!;
  const by = Object.fromEntries(mine.lines.map((l) => [l.itemId, l]));
  assert.deepEqual([by[spread].kind, by[spread].perGuest, by[spread].quantity, by[spread].guests, by[spread].unitPrice, by[spread].lineTotal], ["per guest", true, 100, 100, 58.56, 5856]);
  assert.deepEqual([by[chair].kind, by[chair].quantity, by[chair].guests, by[chair].unitPrice, by[chair].lineTotal], ["each", 3, null, 8, 24]);
  assert.equal(mine.lines.reduce((s2, l) => s2 + (l.lineTotal ?? 0), 0), 5880, "the lines add up to the total");
});

test("the pay link: the same lines, a per-guest one never as quantity 1", async () => {
  const token = (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).payToken as string;
  const pay = await call(`/api/pay/${token}`);
  const items = pay.json.items as Line[];
  const s = items.find((l) => l.itemId === spread)!;
  assert.deepEqual([s.name, s.kind, s.quantity, s.guests, s.unitPrice, s.lineTotal], [`${ZZ} Mediterranean Spread`, "per guest", 100, 100, 58.56, 5856]);
  assert.ok(!items.some((l) => l.perGuest && l.quantity === 1));
  assert.equal(pay.json.total, 5880);
});

test("a storefront request: the same lines and the request total", async () => {
  const r = await post("/api/bookings/direct", { itemIds: [hall, spread], guestCount: 40, eventDate: day(75), eventTime: "4 PM", agreedToPolicy: true, delivery: null, customerName: `${ZZ} Customer` }, cookie);
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const list = (await call("/api/customer/requests", { cookie })).json.requests as { id: string; total: number; items: Line[] }[];
  const req = list.find((x) => x.id === r.json.designRequestId)!;
  assert.equal(req.total, 9500 + 58.56 * 40);
  const by = Object.fromEntries(req.items.map((l) => [l.itemId, l]));
  assert.deepEqual([by[hall].kind, by[hall].quantity, by[hall].lineTotal], ["per day", 1, 9500]);
  assert.deepEqual([by[spread].kind, by[spread].quantity, by[spread].guests, by[spread].lineTotal], ["per guest", 40, 40, 2342.4]);
});

test("{{depositAmount}} and the older contract's retainer line show what the booking owes: payment in full when Settings say so", async () => {
  // At 20%, retainer: the figure is total x 20%.
  let v = await buildMessageValues(accountId, { bookingId });
  assert.equal(v.deposit_amount, "$1,176.00");
  // Collect in full on small rentals: the booking owes the whole total now.
  await prisma.account.update({ where: { id: accountId }, data: { tier1Collect: "full" } });
  v = await buildMessageValues(accountId, { bookingId });
  assert.deepEqual([v.deposit_amount, v.balance_due], ["$5,880.00", "$0.00"]);
  const agreement = await prisma.agreement.findUniqueOrThrow({ where: { bookingId } });
  const older = await buildContractContent(agreement.id);
  assert.match(older.text, /Payment in full: \$5,880\.00/);
  assert.equal(older.depositAmount, 5880);
  await prisma.account.update({ where: { id: accountId }, data: { tier1Collect: "retainer" } });
  assert.match((await buildContractContent(agreement.id)).text, /Retainer \(20%\): \$1,176\.00/);
});

test("a signed contract's own retainer figure wins over today's percent", async () => {
  await prisma.account.update({ where: { id: accountId }, data: { contractRequiredOver: 10 } });
  const q = await post("/api/bookings/tier", { itemId: chair, quantities: { [chair]: 5 }, eventDate: day(80), eventTime: "2 PM" });
  assert.equal(q.json.tier, 2, JSON.stringify(q.json));
  const c = q.json.contract as { quoteId: string; contentHash: string };
  const signed = await post("/api/bookings/direct", { itemId: chair, quantities: { [chair]: 5 }, eventDate: day(80), eventTime: "2 PM", agreedToPolicy: true, delivery: null, tier: 2, signature: { fullName: `${ZZ} Signer`, esignConsent: true, contentHash: c.contentHash, quoteId: c.quoteId } }, cookie);
  assert.equal(signed.status, 201, JSON.stringify(signed.json));
  await prisma.account.update({ where: { id: accountId }, data: { contractRequiredOver: 10000, depositPercentage: 30 } });
  // The contract was signed at 20% of $40: $8. Today's 30% would say $12.
  const v = await buildMessageValues(accountId, { bookingId: signed.json.bookingId as string });
  assert.equal(v.deposit_amount, "$8.00");
  assert.equal(v.retainer_percent, "30", "the settings token still reads today's setting");
  await prisma.account.update({ where: { id: accountId }, data: { depositPercentage: 20 } });
});
