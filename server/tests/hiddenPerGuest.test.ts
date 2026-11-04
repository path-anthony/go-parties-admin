// Block A8, over HTTP on a throwaway database: the hide-from-store flag
// (left out of the catalog and the packages feed, refused by the tier
// call and the public hold, still bookable by staff, the five import
// leftovers hidden by the migration's statement) and per-guest packages
// (fixed packages unchanged, totals, the range refusals, the quote hash
// changing with the count, the count stored on the booking). Twilio is
// stubbed. Every row made here is deleted at the end with counts.
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
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { runAsActor } from "../actor.js";
import { addDays } from "../automation/time.js";
import { prisma } from "../db.js";
import { packagePrice } from "../packagePricing.js";
import { customerWriteGuard } from "../security.js";
import directBookingsRouter, { staffBookingRouter } from "../routes/directBookings.js";
import itemsRouter from "../routes/items.js";
import packagesRouter from "../routes/packages.js";
import publicItemsRouter from "../routes/publicItems.js";
import publicPackagesRouter, { clearPublicPackagesCache } from "../routes/publicPackages.js";
import tierRouter from "../routes/tier.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("hiddenPerGuest.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
const FIVE = ["cmtrfusm00047s5ujfsv0f1qw", "cmtrfusj00046s5ujnyxyzgiw", "cmtrfusg70045s5ujm9d1efji", "cmtrfusr20048s5ujec75yscc", "cmtrfukdk001gs5uj35zzek7s"];
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const made = { items: [] as string[], packages: [] as string[], bookings: [] as string[], quotes: [] as string[], statuses: [] as string[] };
let settingsBefore: Record<string, unknown> | null = null;
let shown = "";
let hidden = "";
let tent = "";
let chairs = "";

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
  return realFetch(input, init);
}) as typeof fetch;

type Res = { status: number; json: Record<string, unknown> };
async function call(path: string, init: RequestInit = {}): Promise<Res> {
  const r = await realFetch(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json", Origin: "https://store.test" } });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => call(path, { method: "PATCH", body: JSON.stringify(body) });
const get = (path: string) => call(path);
const day = (n: number) => addDays(new Date().toISOString().slice(0, 10), n);
let holdCount = 0;
function holdBody(itemIds: string[], over: Record<string, unknown> = {}) {
  holdCount += 1;
  return { itemIds, eventDate: day(60 + holdCount), eventTime: "2 PM", customerName: `${ZZ} Customer ${holdCount}`, phone: `+150055503${String(holdCount).padStart(2, "0")}`, email: `zz-a8-${holdCount}@example.test`, agreedToPolicy: true, delivery: null, address: "9 Event Rd, Avon, CT 06001", ...over };
}
const track = (r: Res) => {
  if (typeof r.json.bookingId === "string") made.bookings.push(r.json.bookingId);
  return r;
};
const trackQuote = (r: Res) => {
  const c = r.json.contract as { quoteId?: string } | null;
  if (c?.quoteId) made.quotes.push(c.quoteId);
  return r;
};

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  settingsBefore = { contractRequiredOver: a.contractRequiredOver, contractRequiredForCrewed: a.contractRequiredForCrewed, fullReviewThreshold: a.fullReviewThreshold, reviewOccasions: a.reviewOccasions, depositPercentage: a.depositPercentage, authorizedSignerName: a.authorizedSignerName, authorizedSignerTitle: a.authorizedSignerTitle, tier1Collect: a.tier1Collect, directBookingDailyCap: a.directBookingDailyCap, requireCustomerAccount: a.requireCustomerAccount };
  await prisma.account.update({ where: { id: accountId }, data: { contractRequiredOver: 1000, contractRequiredForCrewed: true, fullReviewThreshold: 15000, reviewOccasions: ["Wedding"], depositPercentage: 20, authorizedSignerName: "Mel Owner", authorizedSignerTitle: "Owner", tier1Collect: "retainer", directBookingDailyCap: 1000, requireCustomerAccount: false } });
  if ((await prisma.leadStatus.count({ where: { accountId } })) === 0) {
    const s = await prisma.leadStatus.create({ data: { accountId, name: "New", position: 0 } });
    made.statuses.push(s.id);
  }
  const policy = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  if (!policy || policy.text.trim() === "") await prisma.policyVersion.create({ data: { accountId, version: (policy?.version ?? 0) + 1, text: `${ZZ} rental policy: the retainer is {{depositPercentage}}% and non-refundable.` } });
  const mk = (name: string, price: number, extra: Record<string, unknown> = {}) => prisma.item.create({ data: { accountId, name, category: "Games", price, priceUnit: "per event", units: { create: [{ label: "Unit 1" }, { label: "Unit 2" }, { label: "Unit 3" }, { label: "Unit 4" }, { label: "Unit 5" }, { label: "Unit 6" }] }, ...extra } });
  shown = (await mk(`${ZZ} Shown Game`, 120)).id;
  hidden = (await mk(`${ZZ} Hidden Game`, 130)).id;
  tent = (await mk(`${ZZ} Party Tent`, 400)).id;
  chairs = (await mk(`${ZZ} Chairs`, 5)).id;
  made.items.push(shown, hidden, tent, chairs);

  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/bookings/direct", customerWriteGuard);
  app.use("/api/bookings/tier", customerWriteGuard);
  app.use(express.json({ limit: "4mb" }));
  app.use(cookieParser(process.env.COOKIE_SECRET));
  const staff = (_req: express.Request, _res: express.Response, next: express.NextFunction) => runAsActor({ id: "zz-owner", name: "ZZ Owner", role: "Owner" }, () => next());
  app.use("/api/items", publicItemsRouter);
  app.use("/api/items", staff, itemsRouter);
  app.use("/api/packages", publicPackagesRouter);
  app.use("/api/packages", staff, packagesRouter);
  app.use("/api/bookings/direct", directBookingsRouter);
  app.use("/api/bookings/tier", tierRouter);
  app.use("/api/bookings/staff", staff, staffBookingRouter);
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
  const p = await prisma.package.deleteMany({ where: { id: { in: made.packages } } });
  const i = await prisma.item.deleteMany({ where: { OR: [{ id: { in: made.items } }, { id: { in: FIVE } }] } });
  const st = await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } });
  if (settingsBefore) await prisma.account.update({ where: { id: accountId }, data: settingsBefore as object });
  const left = { items: await prisma.item.count({ where: { name: { startsWith: ZZ } } }), packages: await prisma.package.count({ where: { name: { startsWith: ZZ } } }), bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }) };
  console.log(`# cleanup: ${b.count} bookings, ${l.count} leads, ${q.count} quotes, ${p.count} packages, ${i.count} items, ${st.count} lead columns, ${logs.count} message logs; remaining ${JSON.stringify(left)}`);
  await prisma.$disconnect();
});

// ---- the hide flag ------------------------------------------------------------------------
test("the admin sets hidden; the catalog and the packages feed leave the item out; the tier call and the public hold refuse it; staff can still book it", async () => {
  let r = await patch(`/api/items/${hidden}`, { hidden: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.hidden, true);
  r = await patch(`/api/items/${hidden}`, { hidden: "yes" });
  assert.equal(r.status, 400);
  const admin = (await get("/api/items")).json as unknown as { id: string; hidden: boolean }[];
  assert.equal(admin.find((i) => i.id === hidden)?.hidden, true, "the admin list still has it");

  const cat = (await get("/api/items/public")).json as { items: { id: string }[] };
  assert.ok(cat.items.some((i) => i.id === shown));
  assert.equal(cat.items.some((i) => i.id === hidden), false, "hidden is not in the catalog");
  const dated = (await get(`/api/items/public?date=${day(30)}`)).json as { items: { id: string }[] };
  assert.equal(dated.items.some((i) => i.id === hidden), false, "nor on a date");

  const pkg = await prisma.package.create({ data: { accountId, name: `${ZZ} Mixed Pack`, status: "Published", occasions: ["Birthday"], price: 300, items: { create: [{ itemId: shown, quantity: 1 }, { itemId: hidden, quantity: 1 }] } } });
  made.packages.push(pkg.id);
  clearPublicPackagesCache();
  const feed = (await get("/api/packages/public?occasion=Birthday")).json as { packages: { id: string; items: { itemId: string }[] }[] };
  const mine = feed.packages.find((p) => p.id === pkg.id);
  assert.deepEqual(mine?.items.map((i) => i.itemId), [shown], "the hidden item is left out of the package's lines");

  const t = await post("/api/bookings/tier", { itemIds: [shown, hidden], eventDate: day(40) });
  assert.equal(t.status, 400);
  assert.equal(t.json.reason, "hidden");
  assert.equal(t.json.error, "This item isn't available to book online. Call or text GO about it.");
  const h = await post("/api/bookings/direct", holdBody([hidden]));
  assert.equal(h.status, 400);
  assert.equal(h.json.reason, "hidden");
  assert.equal(await prisma.booking.count({ where: { customerName: { startsWith: `${ZZ} Customer` } } }), 0, "nothing was held");

  const s = track(await post("/api/bookings/staff", { itemIds: [hidden], eventDate: day(41), customerName: `${ZZ} Customer staff`, phone: "+15005550399", email: "zz-a8-staff@example.test", agreed: true }));
  assert.equal(s.status, 201, JSON.stringify(s.json));
  const ok = track(await post("/api/bookings/direct", holdBody([shown])));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  r = await patch(`/api/items/${hidden}`, { hidden: false });
  assert.equal((r.json as { hidden: boolean }).hidden, false);
});

test("the migration's statement hides exactly the five import leftovers", async () => {
  const sql = readFileSync(new URL("../../prisma/migrations/20261104120000_hidden_items_per_guest_packages/migration.sql", import.meta.url), "utf8");
  const update = sql.slice(sql.indexOf("UPDATE"), sql.indexOf(";", sql.indexOf("UPDATE")) + 1);
  for (const id of FIVE) assert.ok(update.includes(id), `migration names ${id}`);
  for (const [k, id] of FIVE.entries()) await prisma.item.create({ data: { id, accountId, name: `${ZZ} Leftover ${k + 1}`, category: "Bar and Cigar", price: 100, priceUnit: "per event" } });
  await prisma.$executeRawUnsafe(update);
  const rows = await prisma.item.findMany({ where: { id: { in: FIVE } }, select: { hidden: true } });
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.hidden));
  assert.equal(await prisma.item.count({ where: { hidden: true, id: { notIn: [...FIVE, hidden] } } }), 0, "nothing else was touched");
  const cat = (await get("/api/items/public")).json as { items: { id: string }[] };
  assert.equal(cat.items.some((i) => FIVE.includes(i.id)), false);
});

// ---- per-guest packages ---------------------------------------------------------------------
test("the pricing rule: fixed ignores the count; per guest needs one inside the range and adds the base", () => {
  const fixed = { price: 500, pricingMode: "fixed", basePrice: null, minGuests: null, maxGuests: null };
  assert.equal(packagePrice(fixed, null), 500);
  assert.equal(packagePrice(fixed, 999), 500);
  const pg = { price: "35", pricingMode: "per_guest", basePrice: "250", minGuests: 10, maxGuests: 50 };
  assert.equal(packagePrice(pg, 20), 950);
  assert.equal(packagePrice(pg, 10), 600);
  assert.throws(() => packagePrice(pg, null), /how many guests/);
  assert.throws(() => packagePrice(pg, 9), /10 to 50 guests/);
  assert.throws(() => packagePrice(pg, 51), /10 to 50 guests/);
  assert.throws(() => packagePrice(pg, 2.5), /whole number/);
  assert.equal(packagePrice({ ...pg, basePrice: null, maxGuests: null }, 100), 3500, "no base, no maximum");
});

test("the package editor takes the pricing fields with their checks, and the public feed sends them", async () => {
  let r = await post("/api/packages", { name: `${ZZ} Unicorn Party`, price: 60, pricingMode: "per_guest", basePrice: 100, minGuests: 10, maxGuests: 50, items: [{ itemId: tent, quantity: 1 }, { itemId: chairs, quantity: 1 }], occasions: ["Birthday"] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const pg = r.json as { id: string; pricingMode: string; basePrice: string; minGuests: number; maxGuests: number };
  made.packages.push(pg.id);
  assert.deepEqual([pg.pricingMode, Number(pg.basePrice), pg.minGuests, pg.maxGuests], ["per_guest", 100, 10, 50]);
  r = await post("/api/packages", { name: `${ZZ} Bad`, price: 60, pricingMode: "per_guest", items: [{ itemId: tent, quantity: 1 }] });
  assert.equal(r.status, 400, "minGuests is required per guest");
  r = await patch(`/api/packages/${pg.id}`, { maxGuests: 5 });
  assert.equal(r.status, 400, "max below min");
  r = await patch(`/api/packages/${pg.id}`, { pricingMode: "sideways" });
  assert.equal(r.status, 400);
  r = await patch(`/api/packages/${pg.id}`, { maxGuests: null });
  assert.equal(r.status, 200);
  assert.equal((r.json as { maxGuests: number | null }).maxGuests, null, "blank clears the maximum");
  r = await patch(`/api/packages/${pg.id}`, { maxGuests: 50 });
  assert.equal(r.status, 200);

  const fixed = await post("/api/packages", { name: `${ZZ} Fixed Pack`, price: 450, items: [{ itemId: tent, quantity: 1 }], occasions: ["Birthday"] });
  assert.equal(fixed.status, 201);
  made.packages.push(fixed.json.id as string);
  assert.deepEqual([fixed.json.pricingMode, fixed.json.basePrice, fixed.json.minGuests, fixed.json.maxGuests], ["fixed", null, null, null], "a package with nothing said is fixed");
  r = await patch(`/api/packages/${pg.id}`, { pricingMode: "fixed" });
  assert.deepEqual([r.json.pricingMode, r.json.basePrice, r.json.minGuests, r.json.maxGuests], ["fixed", null, null, null], "fixed clears the per-guest fields");
  r = await patch(`/api/packages/${pg.id}`, { pricingMode: "per_guest", basePrice: 100, minGuests: 10, maxGuests: 50 });
  assert.equal(r.status, 200);

  for (const id of [pg.id, fixed.json.id as string]) await post(`/api/packages/${id}/publish`, {});
  clearPublicPackagesCache();
  const feed = (await get("/api/packages/public")).json as { packages: Record<string, unknown>[] };
  const pub = feed.packages.find((p) => p.id === pg.id) as Record<string, unknown>;
  assert.deepEqual([pub.pricingMode, pub.basePrice, pub.minGuests, pub.maxGuests, pub.price], ["per_guest", 100, 10, 50, 60]);
  const pubFixed = feed.packages.find((p) => p.id === fixed.json.id) as Record<string, unknown>;
  assert.deepEqual([pubFixed.pricingMode, pubFixed.basePrice, pubFixed.minGuests, pubFixed.maxGuests], ["fixed", null, null, null]);
});

test("a fixed package is unchanged: no count needed, a count sent is ignored and not stored", async () => {
  const fixed = await prisma.package.findFirstOrThrow({ where: { name: `${ZZ} Fixed Pack` } });
  const t = await post("/api/bookings/tier", { itemIds: [tent], packageId: fixed.id, eventDate: day(70) });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.equal(t.json.total, 450);
  const held = track(await post("/api/bookings/direct", holdBody([tent], { packageId: fixed.id, guestCount: 25 })));
  assert.equal(held.status, 201, JSON.stringify(held.json));
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: held.json.bookingId as string } });
  assert.equal(Number(b.total), 450);
  assert.equal(b.guestCount, null);
});

test("a per-guest package: the count is required, the range is enforced, the total is base plus price times guests, the quote hash follows the count, and the hold stores it", async () => {
  const pg = await prisma.package.findFirstOrThrow({ where: { name: `${ZZ} Unicorn Party` } });
  const items = [tent, chairs];
  const tier = (over: Record<string, unknown>) => post("/api/bookings/tier", { itemIds: items, packageId: pg.id, eventDate: day(80), eventTime: "2 PM", ...over });
  let t = await tier({});
  assert.equal(t.status, 400);
  assert.equal(t.json.reason, "guest-count-required");
  t = await tier({ guestCount: 9 });
  assert.equal(t.status, 400);
  assert.equal(t.json.reason, "guest-count-range");
  assert.equal(t.json.error, "This package is for 10 to 50 guests.");
  t = await tier({ guestCount: 51 });
  assert.equal(t.json.reason, "guest-count-range");
  t = await tier({ guestCount: "20" });
  assert.equal(t.json.reason, "guest-count-invalid");

  // 20 guests: 100 + 60 x 20 = 1300, over the contract threshold, so tier 2 with a quote.
  const t20 = trackQuote(await tier({ guestCount: 20 }));
  assert.equal(t20.status, 200, JSON.stringify(t20.json));
  assert.equal(t20.json.tier, 2);
  assert.equal(t20.json.total, 1300);
  const q20 = t20.json.contract as { quoteId: string; contentHash: string; document: { event: { expectedGuests: number | null }; payment: { total: number } } };
  assert.equal(Number(q20.document.event.expectedGuests), 20, "the count is on the contract");
  assert.equal(q20.document.payment.total, 130000);
  const t30 = trackQuote(await tier({ guestCount: 30 }));
  assert.equal(t30.json.total, 1900);
  const q30 = t30.json.contract as { contentHash: string };
  assert.notEqual(q30.contentHash, q20.contentHash, "a different count is a different contract");
  const t20again = trackQuote(await tier({ guestCount: 20 }));
  assert.equal((t20again.json.contract as { contentHash: string }).contentHash, q20.contentHash, "the same count hashes the same");

  // The hold: the signed quote for 20 is refused with a count of 30, and accepted with 20.
  const body = { ...holdBody(items, { packageId: pg.id, eventDate: day(80) }), tier: 2, signature: { fullName: "Alex Sample", esignConsent: true, contentHash: q20.contentHash, quoteId: q20.quoteId } };
  let h = track(await post("/api/bookings/direct", { ...body, guestCount: 30 }));
  assert.equal(h.status, 409);
  assert.equal(h.json.reason, "contract-changed");
  h = track(await post("/api/bookings/direct", { ...body, guestCount: 5 }));
  assert.equal(h.status, 400);
  assert.equal(h.json.reason, "guest-count-range");
  h = track(await post("/api/bookings/direct", { ...body }));
  assert.equal(h.status, 400);
  assert.equal(h.json.reason, "guest-count-required");
  h = track(await post("/api/bookings/direct", { ...body, guestCount: 20 }));
  assert.equal(h.status, 201, JSON.stringify(h.json));
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: h.json.bookingId as string } });
  assert.equal(b.guestCount, 20);
  assert.equal(Number(b.total), 1300);
  assert.equal(b.packageId, pg.id);

  // A small count stays tier 1 and holds without a signature.
  const small = trackQuote(await tier({ guestCount: 10, eventDate: day(81) }));
  assert.equal(small.json.tier, 1);
  assert.equal(small.json.total, 700);
  const h1 = track(await post("/api/bookings/direct", holdBody(items, { packageId: pg.id, eventDate: day(81), guestCount: 10 })));
  assert.equal(h1.status, 201, JSON.stringify(h1.json));
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: h1.json.bookingId as string } })).guestCount, 10);
});
