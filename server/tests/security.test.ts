// Tests for the security block. Most are pure. A few touch the production
// database (the daily counter, the login-failure table, a ZZTEST booking for
// signing and hold release); each cleans up after itself and the counts are
// asserted at the end. Nothing here calls Twilio or Anthropic.
delete process.env.EMAIL_WEBHOOK_URL;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { aiGate, restingMessage } from "../ai.js";
import { BOT_MESSAGE, checkBotFields } from "../botCheck.js";
import { serializeCustomerBooking } from "../bookingOps.js";
import { SIGNING_LINK_DAYS_AFTER_EVENT, signContract, signingWindow, ContractError } from "../contracts.js";
import { neutralizeCell } from "../csv.js";
import { prisma } from "../db.js";
import { findExpiredHolds } from "../holds.js";
import { isLockedOut, recordFailure } from "../loginLimit.js";
import { maskEmail, maskPhone, redact, safeErr } from "../log.js";
import { releaseBooking } from "../bookingOps.js";
import { categoryNeedsReview, reviewReasons } from "../review.js";
import { MAX_MESSAGES, MAX_MESSAGE_CHARS, buildSystem, catalogLine, parseMessages } from "../routes/recommend.js";
import { safeInline, safeText, stripControl } from "../sanitize.js";
import { corsPolicy, customerWriteGuard, isPublicRoute, securityHeaders } from "../security.js";
import { takeDaily, usedToday } from "../usage.js";
import { normalizePhotoUrl, INVALID } from "../validate.js";
import { atEastern, addDays } from "../automation/time.js";
import recommendRouter from "../routes/recommend.js";
import directBookingsRouter from "../routes/directBookings.js";
import { markAdmin } from "../ai.js";

let accountId = "";
const ZZ = "ZZTEST";
const created = { bookings: [] as string[], leads: [] as string[], counterDays: [] as string[], loginScopes: [] as string[] };

before(async () => {
  accountId = (await getDefaultAccount()).id;
});

after(async () => {
  const b = await prisma.booking.deleteMany({ where: { id: { in: created.bookings } } });
  const l = await prisma.lead.deleteMany({ where: { id: { in: created.leads } } });
  const c = await prisma.usageCounter.deleteMany({ where: { accountId, day: { in: created.counterDays } } });
  const f = await prisma.loginFailure.deleteMany({ where: { scope: { in: created.loginScopes } } });
  const left = {
    bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }),
    leads: await prisma.lead.count({ where: { customerName: { startsWith: ZZ } } }),
    counters: await prisma.usageCounter.count({ where: { day: { startsWith: "2099-" } } }),
    failures: await prisma.loginFailure.count({ where: { scope: { startsWith: "test:" } } }),
  };
  console.log(`# cleanup: ${b.count} bookings, ${l.count} leads, ${c.count} counter rows, ${f.count} login failures; remaining ${JSON.stringify(left)}`);
  assert.deepEqual(left, { bookings: 0, leads: 0, counters: 0, failures: 0 });
  await prisma.$disconnect();
});

// ---- item 7: logs ---------------------------------------------------------

test("log redaction removes tokens, phones and emails", () => {
  const raw = "failed for https://store.test/sign/TIiG5U6bIJURJ-k53CJiCL-2Qtq1S to +18605550101 or jane@example.com id abcdefghijklmnopqrstuvwxyz0123";
  const out = redact(raw);
  assert.ok(!out.includes("TIiG5U6b") && !out.includes("8605550101") && !out.includes("jane@") && !out.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.match(out, /\/sign\/\[token\]/);
  assert.equal(maskPhone("+18605550101"), "***0101");
  assert.equal(maskEmail("jane@example.com"), "j***@example.com");
  assert.ok(!safeErr(new Error("boom\nsecret body text")).includes("secret body text"));
});

// ---- item 9: outbound text safety ------------------------------------------

test("names and free text lose links and control characters and are capped", () => {
  assert.equal(safeInline("Bob https://evil.example/pay now", 100), "Bob now");
  assert.equal(safeInline("Click evil.com/x now"), "Click now");
  assert.equal(safeInline("Ann\u0000‮Mae​"), "Ann Mae");
  assert.equal(safeInline("x".repeat(500), 50).length, 50);
  assert.equal(safeInline("O'Brien-Smith Jr."), "O'Brien-Smith Jr.");
  assert.equal(safeText("line1\r\nline2 www.bad.io\n\n\n\nline3", 100), "line1\nline2\n\nline3");
  assert.equal(stripControl("jane@gmail.com\u0007"), "jane@gmail.com", "an email address survives untouched");
});

// ---- item 2: bot check -----------------------------------------------------

test("honeypot and timing", () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(checkBotFields({}, { required: false, now }), { ok: true });
  assert.deepEqual(checkBotFields({ hpField: "", formStartedAt: now - 5000 }, { required: true, now }), { ok: true });
  assert.equal((checkBotFields({ hpField: "http://spam" }, { required: false, now }) as { why: string }).why, "honeypot");
  assert.equal((checkBotFields({ hpField: "", formStartedAt: now - 1000 }, { required: false, now }) as { why: string }).why, "too-fast");
  assert.equal((checkBotFields({ formStartedAt: now + 5000 }, { required: false, now }) as { why: string }).why, "too-fast");
  assert.equal((checkBotFields({ formStartedAt: "soon" }, { required: false, now }) as { why: string }).why, "bad-timestamp");
  assert.equal((checkBotFields({ hpField: "" }, { required: true, now }) as { why: string }).why, "fields-required");
  assert.deepEqual(checkBotFields({ formStartedAt: now - 10 }, { required: false, now, minAgeApplies: false }), { ok: true });
  assert.deepEqual(checkBotFields({ hpField: null, formStartedAt: null }, { required: false, now }), { ok: true });
});

let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
before(() => {
  const app = express();
  app.use(express.json({ limit: "20kb" }));
  app.use("/api/recommend", markAdmin, recommendRouter);
  app.use("/api/bookings/direct", directBookingsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("the public write routes refuse a filled honeypot or an instant form with the generic error", async () => {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const recentFrom = Date.now() - 500;
  for (const [path, body] of [
    ["/api/bookings/direct", { hpField: "bot", customerName: "x", itemId: "x" }],
    ["/api/bookings/direct", { hpField: "", formStartedAt: recentFrom, customerName: "x", itemId: "x" }],
    ["/api/recommend", { hpField: "bot", messages: [{ role: "user", content: "hi" }] }],
    ["/api/recommend", { hpField: "", formStartedAt: recentFrom, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }],
  ] as const) {
    const res = await post(path, body);
    assert.equal(res.status, 400, path);
    const j = (await res.json()) as { error: string; reason: string };
    assert.equal(j.reason, "bot-check");
    assert.equal(j.error, BOT_MESSAGE);
  }
});

// ---- item 1: AI caps -------------------------------------------------------

test("a conversation is capped at 10 messages of 500 characters", async () => {
  const ok = Array.from({ length: MAX_MESSAGES }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(MAX_MESSAGE_CHARS) }));
  assert.equal(parseMessages(ok).ok, true);
  const tooMany = parseMessages([...ok, { role: "user", content: "one more" }]);
  assert.deepEqual(tooMany.ok === false && tooMany.reason, "too-many-messages");
  // A long message is clipped to the cap, not refused.
  const clipped = parseMessages([{ role: "user", content: "x".repeat(MAX_MESSAGE_CHARS + 300) }]);
  assert.ok(clipped.ok && clipped.messages[0].content.length === MAX_MESSAGE_CHARS);
  // Over HTTP: message 11 gets a friendly reply the storefront can show, and nothing is spent.
  const publicBefore = await usedToday(accountId, "ai_public");
  const res = await fetch(`${base}/api/recommend`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [...ok, { role: "user", content: "x" }] }) });
  assert.equal(res.status, 200);
  const j = (await res.json()) as { ready: boolean; message: string; limit: string };
  assert.deepEqual([j.ready, j.limit], [false, "conversation"]);
  assert.match(j.message, /Call or text us/);
  assert.equal(await usedToday(accountId, "ai_public"), publicBefore);
});

test("the prompt holds only public fields and the catalog is cached", () => {
  const item = { id: "i1", name: "Snow Cone Station", category: "Fun Foods", price: "150", priceUnit: "Per event", notes: "COST 40 SUPPLIER ACME INTERNAL-SECRET", accountId: "acct", photoUrl: "data:image/png;base64,AAAA" };
  const line = catalogLine(item);
  assert.ok(!line.includes("INTERNAL-SECRET") && !line.includes("ACME") && !line.includes("acct") && !line.includes("data:image"));
  const system = buildSystem([item], "Sweet 16");
  const text = system.map((b) => b.text).join("\n");
  assert.ok(!text.includes("INTERNAL-SECRET"));
  assert.equal(system.length, 3);
  assert.deepEqual(system[1].cache_control, { type: "ephemeral" });
  assert.match(system[1].text, /^Catalog:/);
  assert.equal(system[0].cache_control, undefined);
  assert.match(system[2].text, /Sweet 16/);
  assert.match(restingMessage("(860) 846-7715"), /^Ask GO is resting for today\. Call or text us at \(860\) 846-7715\.$/);
});

test("the daily counter is atomic and persistent; staff calls are never limited", async () => {
  const now = new Date("2099-01-01T15:00:00Z");
  created.counterDays.push("2099-01-01");
  const results = await Promise.all(Array.from({ length: 8 }, () => takeDaily(accountId, "ai_admin", 3, now)));
  assert.equal(results.filter(Boolean).length, 3, "exactly the cap is granted under a race");
  assert.equal(await usedToday(accountId, "ai_admin", now), 3);
  assert.equal(await takeDaily(accountId, "ai_admin", 0, now), false, "a cap of 0 allows nothing");
  assert.equal(await takeDaily(accountId, "ai_admin", 3, new Date("2099-01-02T15:00:00Z")), true, "a new Eastern day starts fresh");
  created.counterDays.push("2099-01-02");
  // An admin session bypasses the public cap and is counted separately.
  const before = await usedToday(accountId, "ai_public");
  const adminBefore = await usedToday(accountId, "ai_admin");
  const adminOk = await aiGate({ headers: {} } as never, { locals: { isAdmin: true } } as never);
  assert.deepEqual(adminOk, { ok: true });
  assert.equal(await usedToday(accountId, "ai_public"), before, "staff use does not touch the public count");
  assert.equal(await usedToday(accountId, "ai_admin"), adminBefore + 1, "and is counted on its own");
  // Put today's real staff count back the way it was.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  await prisma.usageCounter.updateMany({ where: { accountId, key: "ai_admin", day }, data: { count: { decrement: 1 } } });
  await prisma.usageCounter.deleteMany({ where: { accountId, key: "ai_admin", day, count: { lte: 0 } } });
});

// ---- item 5: CORS and CSRF -------------------------------------------------

test("credentialed CORS only on public and customer routes; admin routes refuse foreign origins", async () => {
  assert.ok(isPublicRoute("/customer/me") && isPublicRoute("/bookings/direct") && isPublicRoute("/recommend") && isPublicRoute("/items/abc/availability") && isPublicRoute("/contracts/tok") && isPublicRoute("/bids/tok"));
  assert.ok(!isPublicRoute("/bookings/staff") && !isPublicRoute("/gigs") && !isPublicRoute("/settings") && !isPublicRoute("/items") && !isPublicRoute("/contract-admin/issue") && !isPublicRoute("/bookings/abc"));
  const saved = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = "https://store.test";
  const app = express();
  app.use("/api", corsPolicy);
  app.use("/api/customer", customerWriteGuard);
  app.use(express.json());
  app.all("/api/{*rest}", (_req, res) => void res.json({ ok: true }));
  const s = app.listen(0);
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const pub = await fetch(`${url}/api/customer/me`, { headers: { Origin: "https://store.test" } });
    assert.equal(pub.headers.get("access-control-allow-origin"), "https://store.test");
    assert.equal(pub.headers.get("access-control-allow-credentials"), "true");
    assert.equal((await fetch(`${url}/api/customer/me`, { headers: { Origin: "https://evil.test" } })).status, 403);
    const admin = await fetch(`${url}/api/gigs`, { headers: { Origin: "https://store.test" } });
    assert.equal(admin.status, 403, "even an allowed storefront origin gets nothing on admin routes");
    assert.equal(admin.headers.get("access-control-allow-origin"), null);
    assert.equal((await fetch(`${url}/api/gigs`)).status, 200, "same-origin and server-to-server calls (no Origin) pass");
    const pre = await fetch(`${url}/api/gigs`, { method: "OPTIONS", headers: { Origin: "https://store.test", "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 403);
    // State-changing customer routes: JSON and an allowed Origin.
    const bad = await fetch(`${url}/api/customer/bookings/x/cancel`, { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(bad.status, 403);
    const form = await fetch(`${url}/api/customer/login`, { method: "POST", headers: { Origin: "https://store.test", "Content-Type": "application/x-www-form-urlencoded" }, body: "a=b" });
    assert.equal(form.status, 415);
    const good = await fetch(`${url}/api/customer/login`, { method: "POST", headers: { Origin: "https://store.test", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(good.status, 200);
    const noBody = await fetch(`${url}/api/customer/logout`, { method: "POST", headers: { Origin: "https://store.test", "Content-Type": "application/json" } });
    assert.equal(noBody.status, 200);
  } finally {
    s.close();
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
  }
});

// ---- item 4: headers -------------------------------------------------------

test("security headers", async () => {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.get("/", (_req, res) => void res.send("ok"));
  const s = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/`);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(r.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(r.headers.get("x-powered-by"), null);
  } finally {
    s.close();
  }
});

// ---- item 8: review enforcement --------------------------------------------

test("review rules use every input the customer cannot omit", () => {
  const list = ["Wedding", "Corporate"];
  assert.ok(categoryNeedsReview("Wedding Packages", list));
  assert.ok(categoryNeedsReview("corporate", list));
  assert.ok(!categoryNeedsReview("Inflatables", list));
  const base = { total: 100, fullReviewThreshold: 15000, reviewOccasions: list };
  assert.deepEqual(reviewReasons({ ...base, occasions: ["Birthday", "Reception only"] }), ["occasion"], "a harmless stated occasion no longer hides the package's own");
  assert.deepEqual(reviewReasons({ ...base, occasions: [], categories: ["Wedding Decor"] }), ["occasion"]);
  assert.deepEqual(reviewReasons({ ...base, total: 20000, occasions: [] }), ["threshold"]);
  assert.deepEqual(reviewReasons({ ...base, occasions: ["Birthday"], categories: ["Games"] }), []);
});

// ---- item 11: lows ---------------------------------------------------------

test("CSV cells that start like formulas are neutralized", () => {
  assert.equal(neutralizeCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(neutralizeCell("+1 555"), "'+1 555");
  assert.equal(neutralizeCell("-2+3"), "'-2+3");
  assert.equal(neutralizeCell("@cmd"), "'@cmd");
  assert.equal(neutralizeCell("-12.5"), "-12.5");
  assert.equal(neutralizeCell("Snow Cones"), "Snow Cones");
});

test("photoUrl is an https link or an inline image, nothing else", () => {
  assert.equal(normalizePhotoUrl("https://cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg");
  assert.ok(normalizePhotoUrl("data:image/png;base64,iVBORw0KGgo=") !== INVALID);
  assert.equal(normalizePhotoUrl(""), null);
  assert.equal(normalizePhotoUrl(null), null);
  for (const bad of ["javascript:alert(1)", "http://insecure.example/a.jpg", "data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml;base64,PHN2Zz4=", "ftp://x/a.png", "//evil.test/a.png", "not a url", 5]) {
    assert.equal(normalizePhotoUrl(bad), INVALID, String(bad));
  }
});

test("the customer booking is built field by field", () => {
  const row = {
    id: "b1", accountId: "acct", leadId: "lead-secret", customerId: "cust", packageId: "pkg-secret", automationPaused: true, lastBalanceReminderAt: new Date(),
    eventDate: new Date("2026-10-10"), eventTime: "2 PM", address: "1 Main", customerName: "Pat", phone: "+1", email: "p@x.co", occasion: null, total: "100.00", rush: false,
    balancePaymentPreference: "Manual", balancePaid: false, createdAt: new Date(), updatedAt: new Date(), status: "Held", retainerPaid: false,
    units: [], addons: [], gigs: [], someFutureInternalColumn: "nope",
  };
  const out = serializeCustomerBooking(row as never) as Record<string, unknown>;
  for (const k of ["accountId", "leadId", "customerId", "packageId", "automationPaused", "lastBalanceReminderAt", "retainerPaid", "someFutureInternalColumn"]) assert.ok(!(k in out), `${k} leaked`);
  assert.equal(out.id, "b1");
  assert.equal(out.stage, "Held");
  assert.equal(out.depositPaid, false);
  assert.equal(out.total, 100);
});

test("the admin login lockout is stored in the database", async () => {
  const scope = `test:${Date.now()}`;
  created.loginScopes.push(scope);
  const ip = "203.0.113.9";
  assert.equal(await isLockedOut(scope, ip), false);
  for (let i = 0; i < 4; i++) await recordFailure(scope, ip);
  assert.equal(await isLockedOut(scope, ip), false);
  await recordFailure(scope, ip);
  assert.equal(await isLockedOut(scope, ip), true, "five failures lock out, and it is read back from the table, not from memory");
  assert.equal(await isLockedOut(scope, "203.0.113.10"), false, "other addresses are unaffected");
  assert.equal(await isLockedOut(scope, ip, new Date(Date.now() + 16 * 60_000)), false, "the window is 15 minutes");
  const row = await prisma.loginFailure.findFirst({ where: { scope } });
  assert.ok(row && !row.ipHash.includes("203"), "the address itself is never stored");
});

// ---- item 6 and 3: contracts and holds -------------------------------------

async function makeBooking(opts: { status?: string; days?: number; createdDaysAgo?: number; source?: string; retainerPaid?: boolean }) {
  const policy = await prisma.policyVersion.findFirstOrThrow({ where: { accountId }, orderBy: { version: "desc" } });
  const eventDate = new Date(`${addDays(new Date().toISOString().slice(0, 10), opts.days ?? 30)}T00:00:00Z`);
  const lead = await prisma.lead.create({ data: { accountId, status: "New", source: opts.source ?? "storefront", customerName: `${ZZ} lead` } });
  created.leads.push(lead.id);
  let id = "";
  await prisma.$transaction(async (tx) => {
    const b = await tx.booking.create({
      data: {
        accountId, leadId: lead.id, eventDate, customerName: `${ZZ} Customer`, status: opts.status ?? "Held", retainerPaid: opts.retainerPaid ?? false,
        createdAt: new Date(Date.now() - (opts.createdDaysAgo ?? 0) * 86_400_000),
      },
    });
    await tx.agreement.create({ data: { accountId, bookingId: b.id, policyVersionId: policy.id, checkboxChecked: false, signingToken: `test-${b.id}`, contractStatus: "Sent", contractProvider: "self-hosted" } });
    id = b.id;
  });
  created.bookings.push(id);
  return id;
}

test("signing is refused for cancelled, completed and released bookings, and after 30 days", async () => {
  for (const status of ["Cancelled", "Completed", "Released"]) {
    const id = await makeBooking({ status });
    await assert.rejects(signContract(`test-${id}`, { fullName: "Pat Smith", consentToElectronicSignature: true, agreeToTerms: true, ip: null, userAgent: null }), (e: unknown) => e instanceof ContractError && e.status === 404 && e.reason === "not-found", status);
    const a = await prisma.agreement.findFirstOrThrow({ where: { bookingId: id } });
    assert.equal(await signingWindow(a), "closed");
  }
  const live = await makeBooking({ status: "Held", days: 5 });
  assert.equal(await signingWindow(await prisma.agreement.findFirstOrThrow({ where: { bookingId: live } })), "open");
  const old = await makeBooking({ status: "Held", days: -(SIGNING_LINK_DAYS_AFTER_EVENT + 2) });
  const oldAgreement = await prisma.agreement.findFirstOrThrow({ where: { bookingId: old } });
  assert.equal(await signingWindow(oldAgreement), "expired");
  await assert.rejects(signContract(`test-${old}`, { fullName: "Pat Smith", consentToElectronicSignature: true, agreeToTerms: true, ip: null, userAgent: null }), (e: unknown) => e instanceof ContractError && e.status === 404);
  const edge = await makeBooking({ status: "Held", days: -SIGNING_LINK_DAYS_AFTER_EVENT });
  assert.equal(await signingWindow(await prisma.agreement.findFirstOrThrow({ where: { bookingId: edge } })), "open", "still works on day 30");
  const eventDay = atEastern(addDays(new Date().toISOString().slice(0, 10), 0), 12);
  assert.ok(eventDay.getTime() > 0);
});

test("hold release: only unpaid storefront holds past the limit; staff bookings are never touched", async () => {
  const storefront = await makeBooking({ createdDaysAgo: 10, source: "storefront" });
  const paid = await makeBooking({ createdDaysAgo: 10, source: "storefront", retainerPaid: true });
  const staff = await makeBooking({ createdDaysAgo: 10, source: "manual" });
  const recent = await makeBooking({ createdDaysAgo: 0, source: "storefront" });
  const saved = (await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { holdReleaseDays: true } })).holdReleaseDays;
  try {
    assert.equal(saved, 0, "production has the feature off");
    assert.deepEqual((await findExpiredHolds()).holds, [], "with 0 days nothing is ever due");
    await prisma.account.update({ where: { id: accountId }, data: { holdReleaseDays: 7 } });
    const ids = (await findExpiredHolds()).holds.map((h) => h.bookingId);
    assert.ok(ids.includes(storefront));
    for (const other of [paid, staff, recent]) assert.ok(!ids.includes(other));
  } finally {
    await prisma.account.update({ where: { id: accountId }, data: { holdReleaseDays: saved } });
  }
  // Releasing frees the booking and marks it Released; a paid one is refused.
  assert.equal(await releaseBooking(storefront, "test release"), true);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: storefront } })).status, "Released");
  assert.equal(await prisma.bookingUnit.count({ where: { bookingId: storefront } }), 0);
  assert.equal(await releaseBooking(paid, "test release"), false);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: paid } })).status, "Held");
  assert.equal(await releaseBooking(storefront, "again"), false, "releasing twice does nothing");
});
