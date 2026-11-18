// Block FIX1. One pricing rule, stock for per-guest items, quantities, the
// item cap and the hold limit, Ask GO keeping the cart, the occasion on
// leads, and the retainer terms following Settings. First the rules with no
// database, then over HTTP on a throwaway database. Twilio, the email
// webhook, Stripe and the model are stubbed.
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
delete process.env.ANTHROPIC_API_KEY;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { runAsActor } from "../actor.js";
import { applyCartAction, parseAskCart, wantsCartChange } from "../askCart.js";
import { addBookingItem } from "../bookingOps.js";
import { loadBookingSummary } from "../bookingsLoad.js";
import { buildGoDocument } from "../contract/goLoad.js";
import { buildContractContent } from "../contracts.js";
import { prisma } from "../db.js";
import { buildMessageValues } from "../messageContext.js";
import { occasionFromText, occasionsConflict, settleOccasion } from "../occasionText.js";
import { fillPolicyText, hardcodedInPolicy, suggestPolicyDraft } from "../policy.js";
import { PricingError, countsAgainstStock, isPerGuestUnit, priceCart } from "../pricing.js";
import { countsAsHoldAttempt, directBookingLimiter, rememberRefusalReason } from "../rateLimit.js";
import { customerWriteGuard } from "../security.js";
import { renderMessage } from "../tokens.js";
import { TRIGGERS } from "../triggers.js";
import conciergeLeadsRouter from "../routes/conciergeLeads.js";
import directBookingsRouter from "../routes/directBookings.js";
import { payApiRouter } from "../routes/pay.js";
import publicItemsRouter from "../routes/publicItems.js";
import recommendRouter, { setAskGoModel } from "../routes/recommend.js";
import { publicSettingsRouter } from "../routes/settings.js";
import tierRouter from "../routes/tier.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("fix1Pricing.test.ts runs only against a throwaway database (name containing zz_scratch)");

// ---- the rules, with no database ---------------------------------------------------

describe("one pricing rule", () => {
  const spread = { id: "s", name: "Mediterranean Spread", price: 58.56, priceUnit: "per guest" };
  const chair = { id: "c", name: "Gold Chair", price: 8, priceUnit: "each" };
  test("a per-guest item costs price x guest count; anything else price x quantity", () => {
    assert.equal(priceCart({ items: [spread], guestCount: 100 }).total, 5856);
    assert.equal(priceCart({ items: [chair], quantities: { c: 3 } }).total, 24);
    assert.equal(priceCart({ items: [spread, chair], quantities: { c: 3, s: 7 }, guestCount: 100 }).total, 5880, "a quantity on a per-guest item is ignored");
    const line = priceCart({ items: [spread], guestCount: 100 }).lines[0];
    assert.deepEqual([line.perGuest, line.quantity, line.guests, line.multiplier, line.lineTotal], [true, 1, 100, 100, 5856]);
  });
  test("the guest count is required whenever the cart has a per-guest item", () => {
    assert.throws(() => priceCart({ items: [spread, chair] }), (e: unknown) => e instanceof PricingError && e.reason === "guest-count-required" && /Mediterranean Spread/.test(e.message));
    assert.throws(() => priceCart({ items: [spread], guestCount: 0 }), PricingError);
    assert.equal(priceCart({ items: [chair] }).total, 8, "no per-guest item, no count needed");
  });
  test("add-ons follow their item; a package keeps its own rule", () => {
    assert.equal(priceCart({ items: [spread], guestCount: 10, addons: [{ itemId: "s", priceDelta: 2 }] }).total, 605.6);
    assert.equal(priceCart({ items: [chair], quantities: { c: 4 }, addons: [{ itemId: "c", priceDelta: 1 }] }).total, 36);
    const pkg = { price: 15, pricingMode: "per_guest", basePrice: 100, minGuests: 10, maxGuests: 200 };
    assert.equal(priceCart({ items: [spread, chair], guestCount: 50, pkg }).total, 850, "inside a package the package is the price");
    assert.equal(priceCart({ items: [chair], pkg: { price: 300, pricingMode: "fixed", basePrice: null, minGuests: null, maxGuests: null } }).total, 300);
  });
  test("which units mean per guest, and who counts against stock", () => {
    assert.deepEqual(["per guest", "Per Guest", " per  person ", "per head", "per 10 guests", "each", null].map(isPerGuestUnit), [true, true, true, true, false, false, false]);
    assert.equal(countsAgainstStock({ priceUnit: "per guest" }), false);
    assert.equal(countsAgainstStock({ priceUnit: "per day" }), true);
    assert.equal(countsAgainstStock({ priceUnit: "per guest", countsAgainstStock: true }), true, "staff can turn it on");
    assert.equal(countsAgainstStock({ priceUnit: "each", countsAgainstStock: false }), false);
  });
});

describe("refused attempts and the hold limit", () => {
  test("only a real attempt counts; a bot refusal still does", () => {
    assert.equal(countsAsHoldAttempt(201, undefined), true);
    assert.equal(countsAsHoldAttempt(409, "unavailable"), true);
    assert.equal(countsAsHoldAttempt(400, "too-many-items"), false);
    assert.equal(countsAsHoldAttempt(400, "address-not-exact"), false);
    assert.equal(countsAsHoldAttempt(401, "account-required"), false);
    assert.equal(countsAsHoldAttempt(400, "bot-check"), true);
  });
});

describe("Ask GO and the cart", () => {
  const catalog = new Map([
    ["a", { id: "a", name: "Bounce House", price: 300, priceUnit: "per day" }],
    ["b", { id: "b", name: "Snack Station", price: 10, priceUnit: "per guest" }],
    ["c", { id: "c", name: "DJ", price: 600, priceUnit: "per event" }],
  ]);
  test("the store's cart is read against the catalog", () => {
    assert.deepEqual(parseAskCart([{ itemId: "a", quantity: 2 }, "b", { itemId: "zzz" }, { itemId: "a" }, 42], catalog).map((l) => [l.id, l.quantity]), [["a", 2], ["b", 1]]);
  });
  test("none keeps the cart; add, remove and replace do what they say", () => {
    const cur = parseAskCart(["a", "b"], catalog);
    assert.deepEqual(applyCartAction(cur, "none", ["c"], catalog).map((l) => l.id), ["a", "b"]);
    assert.deepEqual(applyCartAction(cur, "add", ["c", "a"], catalog).map((l) => l.id), ["a", "b", "c"]);
    assert.deepEqual(applyCartAction(cur, "remove", ["b"], catalog).map((l) => l.id), ["a"]);
    assert.deepEqual(applyCartAction(cur, "replace", ["c"], catalog).map((l) => l.id), ["c"]);
  });
  test("a question never changes a cart; an answer or a request may", () => {
    for (const q of ["what if it rains", "What if it rains?", "Do you deliver to Avon?", "How much space do we need?", "Do we need power for the bounce house?", "Is delivery extra"]) assert.equal(wantsCartChange(q), false, q);
    for (const c of ["add a bounce house", "lower the total", "swap the DJ for a band", "Can we get a photo booth too?", "keep it under $800", "Looks good, book it", "Make it for 30", "about 50 guests", "$2,000"]) assert.equal(wantsCartChange(c), true, c);
  });
});

describe("the occasion comes from the customer's words", () => {
  test("read from text", () => {
    assert.equal(occasionFromText("Graduation party for 60 in the backyard"), "Graduation");
    assert.equal(occasionFromText("my son's grad party"), "Graduation");
    assert.equal(occasionFromText("Planning a bachelor party for 20"), "Bachelor/Bachelorette");
    assert.equal(occasionFromText("team building day for 40 people"), "Team building");
    assert.equal(occasionFromText("a party"), null);
  });
  test("a conflict with the store's pick is caught; a group agrees with its own occasions", () => {
    assert.equal(occasionsConflict("Team building", "Graduation"), true);
    assert.equal(occasionsConflict("Kids party", "Graduation"), false);
    assert.equal(occasionsConflict("Birthday", "Birthday"), false);
    assert.equal(occasionsConflict("Other", "Graduation"), false);
    assert.equal(occasionsConflict(null, "Graduation"), false);
    assert.deepEqual(settleOccasion("Team building", "Graduation party for 60"), { occasion: "Graduation", fromStore: "Team building", fromChat: "Graduation", conflict: true });
    assert.deepEqual(settleOccasion("Team building", "a party for 30"), { occasion: "Team building", fromStore: "Team building", fromChat: null, conflict: false });
  });
});

describe("the retainer terms follow Settings", () => {
  const live = "GO Event Group, Booking & Cancellation Policy\n\nHolding your date. A deposit of 20% of your total is due at booking. Your date is not held until this deposit is received.\n\nRemaining balance. The rest of your total is due 30 days before your event.\n\nCancelling close to your event. If you cancel within 30 days of your event date, your full balance becomes due in full and is non-refundable.";
  const settings = { depositPercentage: 25, cancellationWindowDays: 30, balanceDueDays: 30, rescheduleFeePercent: 10 };
  test("every name a number has is filled, camelCase or snake_case", () => {
    assert.equal(fillPolicyText("{{retainerPercent}}% / {{deposit_percentage}}% / {{retainer_percent}}% / {{balanceDueDays}} / {{cancellation_window_days}} / {{unknown}}", settings), "25% / 25% / 25% / 30 / 30 / {{unknown}}");
  });
  test("what is still typed in is found, and the suggested draft takes it from Settings", () => {
    assert.deepEqual(hardcodedInPolicy(live).sort(), ['"deposit"', "20%", "30 days"].sort());
    const draft = suggestPolicyDraft(live, settings);
    assert.match(draft, /A retainer of \{\{retainerPercent\}\}% of your total is due at booking/);
    assert.match(draft, /until this retainer is received/);
    assert.match(draft, /due \{\{balanceDueDays\}\} days before your event/);
    assert.match(draft, /within \{\{cancellationWindowDays\}\} days of your event date/);
    assert.ok(!/deposit|20%/i.test(draft));
    assert.equal(fillPolicyText(draft, settings).includes("A retainer of 25% of your total"), true);
    assert.deepEqual(hardcodedInPolicy(draft), []);
  });
  test("every customer message can quote the settings numbers", () => {
    for (const t of TRIGGERS.filter((x) => x.journey !== "crew")) for (const k of ["retainerPercent", "balanceDueDays", "cancellationWindowDays"]) assert.ok(t.tokens.includes(k), `${t.key} ${k}`);
    assert.equal(renderMessage("Your retainer is {{retainerPercent}}%, due {{balanceDueDays}} days out.", { retainer_percent: "25", balance_due_days: "30" }, ["retainerPercent", "balanceDueDays"]).text, "Your retainer is 25%, due 30 days out.");
  });
});

// ---- over HTTP, on a throwaway database -------------------------------------------
const ZZ = "ZZFIX";
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let settingsBefore: Record<string, unknown> | null = null;
const made = { items: [] as string[], policies: [] as string[], statuses: [] as string[] };
let spread = "";
let chair = "";
let many: string[] = [];
let ipBase = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
  if (url.startsWith("http://stub.invalid/")) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  return realFetch(input, init);
}) as typeof fetch;

type Res = { status: number; json: Record<string, unknown> };
async function call(path: string, init: RequestInit & { ip?: string } = {}): Promise<Res> {
  ipBase += 1;
  const r = await realFetch(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json", Origin: "https://store.test", "X-Forwarded-For": init.ip ?? `10.9.${Math.floor(ipBase / 200)}.${ipBase % 200}` } });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const post = (path: string, body: unknown, ip?: string) => call(path, { method: "POST", body: JSON.stringify(body), ip });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let holdN = 0;
const hold = (over: Record<string, unknown>) => {
  holdN += 1;
  return { eventDate: day(70), eventTime: "2 PM", customerName: `${ZZ} Customer ${holdN}`, phone: `860-555-${String(1000 + holdN)}`, email: `zz-fix-${holdN}@example.test`, agreedToPolicy: true, delivery: null, tier: 1, ...over };
};

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  settingsBefore = { reviewAmountKids: a.reviewAmountKids, reviewAmountAdult: a.reviewAmountAdult, reviewAmountWedding: a.reviewAmountWedding, reviewAmountCorporate: a.reviewAmountCorporate, reviewAmountDefault: a.reviewAmountDefault, contractRequiredOver: a.contractRequiredOver, contractRequiredForCrewed: a.contractRequiredForCrewed, requireAgreementCheckbox: a.requireAgreementCheckbox, requireCustomerAccount: a.requireCustomerAccount, directBookingDailyCap: a.directBookingDailyCap, requireBotCheck: a.requireBotCheck, depositPercentage: a.depositPercentage, tier1Collect: a.tier1Collect, useGoContract: a.useGoContract, maxItemsPerBooking: a.maxItemsPerBooking, balanceDueDays: a.balanceDueDays };
  await prisma.account.update({ where: { id: accountId }, data: { reviewAmountKids: 100000, reviewAmountAdult: 100000, reviewAmountWedding: 100000, reviewAmountCorporate: 100000, reviewAmountDefault: 100000, contractRequiredOver: 10000, contractRequiredForCrewed: true, requireAgreementCheckbox: false, requireCustomerAccount: false, directBookingDailyCap: 1000, requireBotCheck: false, depositPercentage: 20, tier1Collect: "retainer", useGoContract: true, maxItemsPerBooking: 40, balanceDueDays: 14 } });
  for (const [i, name] of ["New", "Contacted", "Booked", "Lost"].entries()) {
    if ((await prisma.leadStatus.count({ where: { accountId, name } })) === 0) made.statuses.push((await prisma.leadStatus.create({ data: { accountId, name, position: i } })).id);
  }
  // The live wording, with its percent typed in, as production has it.
  const last = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  made.policies.push((await prisma.policyVersion.create({ data: { accountId, version: (last?.version ?? 0) + 1, text: `${ZZ} policy. A retainer of {{retainerPercent}}% of your total holds the date. The balance is due {{balanceDueDays}} days before.` } })).id);
  const mk = async (name: string, price: number, priceUnit: string, units: number) => {
    const item = await prisma.item.create({ data: { accountId, name: `${ZZ} ${name}`, category: "Catering", price, priceUnit, units: { create: Array.from({ length: units }, (_, i) => ({ label: String(i + 1) })) } } });
    made.items.push(item.id);
    return item.id;
  };
  // One unit, the way every per-guest item is set up in production.
  spread = await mk("Mediterranean Spread", 58.56, "per guest", 1);
  chair = await mk("Gold Chair", 8, "each", 10);
  many = [];
  for (let i = 0; i < 25; i++) many.push(await mk(`Small Thing ${String(i).padStart(2, "0")}`, 5, "each", 1));

  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/bookings/direct", customerWriteGuard);
  app.use(express.json({ limit: "64kb" }));
  app.use((_req, res, next) => {
    res.locals.isAdmin = false;
    next();
  });
  const staff = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.locals.isAdmin = true;
    runAsActor({ id: "zz-owner", name: "ZZ Owner", role: "Owner" }, () => next());
  };
  app.use("/api/bookings/direct", rememberRefusalReason, directBookingLimiter, directBookingsRouter);
  app.use("/api/bookings/tier", tierRouter);
  app.use("/api/pay", payApiRouter);
  app.use("/api/items", publicItemsRouter);
  app.use("/api/settings", publicSettingsRouter);
  app.use("/api/recommend", staff, recommendRouter);
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
  setAskGoModel(null);
  globalThis.fetch = realFetch;
  const bookingIds = (await prisma.booking.findMany({ where: { accountId, customerName: { startsWith: ZZ } }, select: { id: true } })).map((b) => b.id);
  const counts = {
    messages: (await prisma.messageLog.deleteMany({ where: { bookingId: { in: bookingIds } } })).count,
    notifications: (await prisma.notification.deleteMany({ where: { OR: [{ bookingId: { in: bookingIds } }, { body: { contains: ZZ } }, { title: { contains: ZZ } }] } })).count,
    bookings: (await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } })).count,
    leads: (await prisma.lead.deleteMany({ where: { accountId, OR: [{ customerName: { startsWith: ZZ } }, { contact: { contains: "zz-fix-" } }] } })).count,
    items: (await prisma.item.deleteMany({ where: { id: { in: made.items } } })).count,
    policies: (await prisma.policyVersion.deleteMany({ where: { id: { in: made.policies } } }).catch(() => ({ count: -1 }))).count,
    statuses: (await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } }).catch(() => ({ count: -1 }))).count,
  };
  if (settingsBefore) await prisma.account.update({ where: { id: accountId }, data: settingsBefore as object });
  console.log("cleanup", JSON.stringify(counts), "remaining", JSON.stringify({ bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }), items: await prisma.item.count({ where: { name: { startsWith: ZZ } } }) }));
  await prisma.$disconnect();
});

test("100 guests of a $58.56 per-guest item is $5,856 in the tier check, the hold, the retainer, both contracts and the admin", async () => {
  const noCount = await post("/api/bookings/tier", { itemIds: [spread, chair], eventDate: day(70) });
  assert.deepEqual([noCount.status, noCount.json.reason], [400, "guest-count-required"]);
  const tier = await post("/api/bookings/tier", { itemId: spread, eventDate: day(70), guestCount: 100 });
  assert.equal(tier.status, 200, JSON.stringify(tier.json));
  assert.deepEqual([tier.json.tier, tier.json.total, tier.json.retainerAmount, tier.json.guestCount], [1, 5856, 1171.2, 100]);
  assert.deepEqual((tier.json.lines as { perGuest: boolean; guests: number; lineTotal: number }[]).map((l) => [l.perGuest, l.guests, l.lineTotal]), [[true, 100, 5856]]);

  const refusedHold = await post("/api/bookings/direct", hold({ itemId: spread }));
  assert.deepEqual([refusedHold.status, refusedHold.json.reason, refusedHold.json.field], [400, "guest-count-required", "guestCount"]);
  const h = await post("/api/bookings/direct", hold({ itemId: spread, guestCount: 100 }));
  assert.equal(h.status, 201, JSON.stringify(h.json));
  assert.equal(h.json.total, 5856);
  const id = h.json.bookingId as string;
  const b = await prisma.booking.findUniqueOrThrow({ where: { id }, include: { lines: true, units: true, agreement: true } });
  assert.deepEqual([Number(b.total), b.guestCount, b.units.length], [5856, 100, 0], "no unit is held for a per-guest item");
  assert.deepEqual(b.lines.map((l) => [l.itemName, l.perGuest, l.guests, Number(l.lineTotal)]), [[`${ZZ} Mediterranean Spread`, true, 100, 5856]]);

  // The retainer and balance on the pay link.
  const pay = await call(`/api/pay/${b.payToken}`);
  assert.deepEqual([pay.json.step, pay.json.amount, pay.json.total, pay.json.balance], ["retainer", 1171.2, 5856, 4684.8]);
  assert.deepEqual(pay.json.items, [{ name: `${ZZ} Mediterranean Spread`, quantity: 1 }]);

  // The older contract layout and the GO contract.
  const older = await buildContractContent(b.agreement!.id);
  assert.equal(older.total, 5856);
  assert.match(older.text, /Mediterranean Spread, 100 guests \(\$58\.56 per guest, \$5,856\.00\)/);
  assert.match(older.text, /Retainer \(20%\): \$1,171\.20/);
  const go = await buildGoDocument(b.agreement!.id);
  assert.equal(go.document.payment.total, 585600);
  assert.ok(JSON.stringify(go.document).includes("Mediterranean Spread (100 guests)"));
  assert.equal(go.document.event.expectedGuests, "100", "the guest count fills the contract's expected guests");

  // The admin's booking money.
  const summary = await loadBookingSummary(accountId, id);
  assert.deepEqual([summary?.money.total, summary?.money.owedNow, summary?.row.items], [5856, 1171.2, `${ZZ} Mediterranean Spread`]);
});

test("a quantity of 3 locks 3 units and charges 3 times; asking for more than is free names the item", async () => {
  const t = await post("/api/bookings/tier", { itemId: chair, quantities: { [chair]: 3 }, eventDate: day(71) });
  assert.equal(t.json.total, 24);
  const h = await post("/api/bookings/direct", hold({ itemId: chair, quantities: { [chair]: 3 }, eventDate: day(71) }));
  assert.equal(h.status, 201, JSON.stringify(h.json));
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: h.json.bookingId as string }, include: { units: true } });
  assert.deepEqual([b.units.length, Number(b.total)], [3, 24]);
  const tooMany = await post("/api/bookings/direct", hold({ itemId: chair, quantities: { [chair]: 8 }, eventDate: day(71) }));
  assert.equal(tooMany.status, 409);
  assert.match(String(tooMany.json.error), new RegExp(`only 7 of ${ZZ} Gold Chair are free \\(you asked for 8\\)`));
  const bad = await post("/api/bookings/direct", hold({ itemId: chair, quantities: { [chair]: 0 }, eventDate: day(71) }));
  assert.deepEqual([bad.status, bad.json.reason], [400, "quantity-invalid"]);
});

test("a per-guest item that does not count against stock can be booked by two customers on the same date, and the daily maximum is kept", async () => {
  const date = day(72);
  const one = await post("/api/bookings/direct", hold({ itemId: spread, guestCount: 40, eventDate: date }));
  const two = await post("/api/bookings/direct", hold({ itemId: spread, guestCount: 60, eventDate: date }));
  assert.deepEqual([one.status, two.status], [201, 201], JSON.stringify([one.json, two.json]));
  const free = await call(`/api/items/${spread}/availability?date=${date}`);
  assert.deepEqual([free.json.available, free.json.directBooking], [true, true]);
  // A maximum of 2 a day: the third is refused by name.
  await prisma.item.update({ where: { id: spread }, data: { maxPerDay: 2 } });
  const three = await post("/api/bookings/direct", hold({ itemId: spread, guestCount: 20, eventDate: date }));
  assert.equal(three.status, 409);
  assert.match(String(three.json.error), /Mediterranean Spread is fully booked that day/);
  const browse = await call(`/api/items/public?date=${date}`);
  assert.equal((browse.json.items as { id: string }[]).some((i) => i.id === spread), false, "full for the day, so not offered");
  await prisma.item.update({ where: { id: spread }, data: { maxPerDay: null } });
  // Staff turning stock back on makes it hold its one unit again.
  await prisma.item.update({ where: { id: spread }, data: { countsAgainstStock: true } });
  const locked = await post("/api/bookings/direct", hold({ itemId: spread, guestCount: 20, eventDate: day(73) }));
  const lockedOut = await post("/api/bookings/direct", hold({ itemId: spread, guestCount: 20, eventDate: day(73) }));
  assert.deepEqual([locked.status, lockedOut.status], [201, 409]);
  await prisma.item.update({ where: { id: spread }, data: { countsAgainstStock: null } });
  // The admin adds it to a booking that has a guest count, priced on that count.
  const host = await post("/api/bookings/direct", hold({ itemId: chair, eventDate: day(74), guestCount: 50 }));
  const added = await addBookingItem(host.json.bookingId as string, { id: spread, name: `${ZZ} Mediterranean Spread`, price: 58.56, priceUnit: "per guest", skills: [], unitCount: 1, countsAgainstStock: null, maxPerDay: null });
  assert.deepEqual([Number(added.total), added.lines.length], [8 + 2928, 1]);
});

test("25 items hold in one booking; 41 are refused by the setting", async () => {
  const h = await post("/api/bookings/direct", hold({ itemIds: many, eventDate: day(75) }));
  assert.equal(h.status, 201, JSON.stringify(h.json));
  assert.equal(h.json.total, 125);
  const settings = await call("/api/settings/public");
  assert.equal(settings.json.maxItemsPerBooking, 40);
  const fake = Array.from({ length: 41 }, (_, i) => `zz-not-real-${i}`);
  const r = await post("/api/bookings/direct", hold({ itemIds: fake }));
  assert.deepEqual([r.status, r.json.reason, r.json.max], [400, "too-many-items", 40]);
  const t = await post("/api/bookings/tier", { itemIds: fake, eventDate: day(75) });
  assert.deepEqual([t.status, t.json.reason], [400, "too-many-items"]);
});

test("5 refused validation errors do not use up the hourly hold limit", async () => {
  const ip = "10.77.0.1";
  for (let i = 0; i < 5; i++) {
    const r = await post("/api/bookings/direct", hold({ itemIds: Array.from({ length: 41 }, (_, k) => `zz-x-${k}`) }), ip);
    assert.equal(r.status, 400);
  }
  for (let i = 0; i < 5; i++) {
    const r = await post("/api/bookings/direct", hold({ itemId: chair, eventDate: day(80 + i) }), ip);
    assert.equal(r.status, 201, `real attempt ${i + 1}: ${JSON.stringify(r.json)}`);
  }
  const sixth = await post("/api/bookings/direct", hold({ itemId: chair, eventDate: day(86) }), ip);
  assert.equal(sixth.status, 429, "the sixth real attempt in the hour is limited");
});

test("Ask GO answering 'what if it rains' returns cartAction none and keeps the cart; a request changes it and the total uses the rule", async () => {
  const reply = (input: Record<string, unknown>) =>
    setAskGoModel(async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "respond_to_party_request", input }] }) as unknown as Pick<Anthropic.Message, "content" | "stop_reason">);
  const messages = [
    { role: "user", content: "Backyard grad party for 60, about $5000" },
    { role: "assistant", content: "Here is a lineup for 60." },
    { role: "user", content: "what if it rains" },
  ];
  const cart = [{ itemId: spread }, { itemId: chair, quantity: 4 }];
  // The model even tries to swap the cart: the cart stays.
  reply({ ready: true, message: "If rain is in the forecast you can move the date for free until the crew leaves.", item_ids: [many[0]], cart_action: "replace", suggest_concierge: false, suggestions: [] });
  const r = await post("/api/recommend", { messages, cart, guestCount: 60 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.cartAction, r.json.ready, "items" in r.json], ["none", false, false]);
  assert.equal(r.json.occasion, "Graduation");
  // A real request: add, and the total is per guest x 60 plus 4 chairs.
  reply({ ready: true, message: "Added a small thing for the table, still well inside the budget.", item_ids: [many[1]], cart_action: "add", guest_count: 60, suggest_concierge: false, suggestions: [] });
  const add = await post("/api/recommend", { messages: [...messages.slice(0, 2), { role: "user", content: "add something small for the tables" }], cart, guestCount: 60 });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  assert.deepEqual([add.json.cartAction, add.json.ready, add.json.added, add.json.removed], ["add", true, [many[1]], []]);
  assert.deepEqual((add.json.items as { id: string }[]).map((i) => i.id), [spread, chair, many[1]]);
  assert.equal(add.json.total, Math.round((58.56 * 60 + 8 * 4 + 5) * 100) / 100);
});

test("a 'Talk to us' lead takes its occasion from the conversation and keeps what the store sent", async () => {
  const r = await post("/api/leads/concierge", { source: "ask_go", occasion: "Team building", itemOrPackage: "Snack Station", name: `${ZZ} Grad Parent`, email: "zz-fix-grad@example.test", messages: [{ role: "user", content: "Graduation party for 60 in the backyard" }, { role: "assistant", content: "Budget?" }, { role: "user", content: "Not sure yet" }] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: r.json.leadId as string }, include: { activities: true } });
  assert.deepEqual([lead.occasion, lead.occasionFromStore, lead.occasionFromChat], ["Graduation", "Team building", "Graduation"]);
  assert.ok(lead.activities.some((a) => /Occasion mismatch/.test(a.text)));
});

test("changing the retainer to 25% changes the policy, the contract and the messages shown afterward, but not an already signed contract", async () => {
  // A signed GO contract at checkout, at 20%.
  await prisma.account.update({ where: { id: accountId }, data: { contractRequiredOver: 10 } });
  const q = await post("/api/bookings/tier", { itemId: chair, quantities: { [chair]: 2 }, eventDate: day(90), eventTime: "2 PM", occasion: "Birthday" });
  assert.equal(q.json.tier, 2, JSON.stringify(q.json));
  const contract = q.json.contract as { quoteId: string; contentHash: string };
  const signed = await post("/api/bookings/direct", hold({ itemId: chair, quantities: { [chair]: 2 }, eventDate: day(90), occasion: "Birthday", tier: 2, signature: { fullName: `${ZZ} Signer`, esignConsent: true, contentHash: contract.contentHash, quoteId: contract.quoteId } }));
  assert.equal(signed.status, 201, JSON.stringify(signed.json));
  const signedDoc = (await prisma.contractDocument.findFirstOrThrow({ where: { agreement: { bookingId: signed.json.bookingId as string } } })).documentJson as { payment: { retainerPercent: number } };
  assert.equal(signedDoc.payment.retainerPercent, 20);
  // A small rental agreed at checkout at 20%: what they saw is kept.
  await prisma.account.update({ where: { id: accountId }, data: { contractRequiredOver: 10000 } });
  const small = await post("/api/bookings/direct", hold({ itemId: chair, eventDate: day(91) }));
  const smallAgreement = await prisma.agreement.findUniqueOrThrow({ where: { bookingId: small.json.bookingId as string } });
  assert.match(smallAgreement.policyTextSeen ?? "", /A retainer of 20% of your total/);

  await prisma.account.update({ where: { id: accountId }, data: { depositPercentage: 25 } });
  // The policy the store shows now.
  const pub = await call("/api/settings/public");
  assert.match(String(pub.json.policyFilled), /A retainer of 25% of your total/);
  assert.equal(pub.json.retainerPercent, 25);
  const t1 = await post("/api/bookings/tier", { itemId: chair, eventDate: day(92) });
  assert.match(String((t1.json.policy as { text: string }).text), /A retainer of 25%/);
  assert.equal(t1.json.retainerAmount, 2);
  // A contract made now.
  const fresh = await post("/api/bookings/direct", hold({ itemId: chair, eventDate: day(93) }));
  const freshAgreement = await prisma.agreement.findUniqueOrThrow({ where: { bookingId: fresh.json.bookingId as string } });
  const go = await buildGoDocument(freshAgreement.id);
  assert.equal(go.document.payment.retainerPercent, 25);
  assert.match((await buildContractContent(freshAgreement.id)).text, /Retainer \(25%\)/);
  // A message sent now.
  const values = await buildMessageValues(accountId, { bookingId: fresh.json.bookingId as string });
  assert.equal(values.retainer_percent, "25");
  // Already signed and already accepted: unchanged.
  const stillDoc = (await prisma.contractDocument.findFirstOrThrow({ where: { agreement: { bookingId: signed.json.bookingId as string } } })).documentJson as { payment: { retainerPercent: number } };
  assert.equal(stillDoc.payment.retainerPercent, 20);
  assert.match((await prisma.agreement.findUniqueOrThrow({ where: { id: smallAgreement.id } })).policyTextSeen ?? "", /A retainer of 20%/);
  await prisma.account.update({ where: { id: accountId }, data: { depositPercentage: 20 } });
});
