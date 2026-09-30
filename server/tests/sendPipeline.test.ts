// Integration test for sendTemplatedMessage against the real database with
// Twilio and the email webhook replaced by a stub, so nothing can actually
// be sent. Every row it writes has an idempotency key starting "test:" and
// is deleted at the end, along with any template rows it makes.
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.EMAIL_WEBHOOK_URL = "http://stub.invalid/hook";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { sendTemplatedMessage } from "../sendTemplated.js";

const realFetch = globalThis.fetch;
let calls: { url: string; body: string }[] = [];
const RUN = `test:${Date.now()}`;
let accountId = "";
// A nurture text, a transactional staff notice, and a client reminder are
// enough to cover every rule. lead_nurture_day10 is used for rows so a
// real customization of it is never disturbed (checked in before()).
const NURTURE = "lead_nurture_day10";

const nurtureCtx = { extra: { customerFirstName: "Sam", eventType: "Sweet 16" } };
const wed = new Date("2026-09-30T16:00:00Z"); // Wednesday noon Eastern
const sun = new Date("2026-10-04T16:00:00Z"); // Sunday noon Eastern
const wedNight = new Date("2026-10-01T02:00:00Z"); // Wednesday 10 PM Eastern
const key = (n: string) => `${RUN}:${n}`;
const rowFor = (k: string, ch = "sms") => prisma.messageLog.findUnique({ where: { idempotencyKey: `${k}:${ch}` } });

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const existing = await prisma.messageTemplate.count({ where: { accountId, triggerKey: NURTURE } });
  assert.equal(existing, 0, `${NURTURE} has a real customization; pick another trigger for the test`);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    if (String(url).includes("twilio")) return new Response(JSON.stringify({ sid: "SMtest" }), { status: 201 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await prisma.messageLog.deleteMany({ where: { idempotencyKey: { startsWith: RUN } } });
  await prisma.messageTemplate.deleteMany({ where: { accountId, triggerKey: NURTURE } });
  await prisma.$disconnect();
});

test("a normal send goes once, is logged with its trigger and key, and carries the rendered text", async () => {
  calls = [];
  const [o] = await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "(860) 555-0101" }, key("a"), { now: wed });
  assert.equal(o.status, "sent");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("twilio"));
  assert.match(decodeURIComponent(calls[0].body), /To=\+18605550101/);
  const row = await rowFor(key("a"));
  assert.equal(row?.triggerKey, NURTURE);
  assert.equal(row?.journey, "lead");
  assert.equal(row?.status, "sent");
  assert.match(row?.body ?? "", /Hi Sam, last note from GO! Event Group\. If your Sweet 16 is still on/);
  assert.ok(row?.body.endsWith("Reply STOP to opt out."));
});

test("the same key again does nothing: no second send, no second row", async () => {
  calls = [];
  const [o] = await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "(860) 555-0101" }, key("a"), { now: wed });
  assert.equal(o.duplicate, true);
  assert.equal(calls.length, 0);
  assert.equal(await prisma.messageLog.count({ where: { idempotencyKey: `${key("a")}:sms` } }), 1);
});

test("two calls racing on one key send exactly once", async () => {
  calls = [];
  const [a, b] = await Promise.all([
    sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "8605550102" }, key("race"), { now: wed }),
    sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "8605550102" }, key("race"), { now: wed }),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual([a[0].duplicate ?? false, b[0].duplicate ?? false].sort(), [false, true]);
  assert.equal(await prisma.messageLog.count({ where: { idempotencyKey: `${key("race")}:sms` } }), 1);
});

test("a different key sends again; each channel has its own key", async () => {
  calls = [];
  await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "8605550103" }, key("b"), { now: wed });
  assert.equal(calls.length, 1);
  assert.ok(await rowFor(key("b"), "sms"));
  assert.equal(await rowFor(key("b"), "email"), null, "email is off by default for this message, so nothing is logged for it");
});

test("a message with a missing token is blocked, logged, and never sent", async () => {
  calls = [];
  const [o] = await sendTemplatedMessage(NURTURE, { extra: { customerFirstName: "Sam" } }, { phone: "8605550104" }, key("miss"), { now: wed });
  assert.equal(o.status, "blocked_missing_field");
  assert.match(o.error ?? "", /eventType/);
  assert.equal(calls.length, 0);
  assert.equal((await rowFor(key("miss")))?.status, "blocked_missing_field");
});

test("a blocked message is retried on its own row once the data exists", async () => {
  calls = [];
  const [o] = await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "8605550104" }, key("miss"), { now: wed });
  assert.equal(o.status, "sent");
  assert.equal(calls.length, 1);
  assert.equal(await prisma.messageLog.count({ where: { idempotencyKey: `${key("miss")}:sms` } }), 1);
});

test("a nurture text on a Sunday is deferred, not sent, then goes on a weekday under the same key", async () => {
  calls = [];
  const [d] = await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "8605550105" }, key("sun"), { now: sun });
  assert.equal(d.status, "deferred_sunday");
  assert.equal(calls.length, 0);
  assert.equal((await rowFor(key("sun")))?.status, "deferred_sunday");
  const [s] = await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "8605550105" }, key("sun"), { now: wed });
  assert.equal(s.status, "sent");
  assert.equal(calls.length, 1);
  assert.equal(await prisma.messageLog.count({ where: { idempotencyKey: `${key("sun")}:sms` } }), 1);
});

test("a nurture text at 10 PM is deferred for quiet hours", async () => {
  calls = [];
  const [d] = await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "8605550106" }, key("night"), { now: wedNight });
  assert.equal(d.status, "deferred_quiet_hours");
  assert.equal(calls.length, 0);
});

test("a transactional text goes at 10 PM on a Sunday", async () => {
  calls = [];
  const sundayNight = new Date("2026-10-05T02:00:00Z");
  const [o] = await sendTemplatedMessage("staff_contract_signed", { extra: { customerName: "Sam Miller", eventDate: "Sat, Oct 10", contractPdfLink: "https://example.com/c.pdf" } }, { phone: "8605550107" }, key("tx"), {
    now: sundayNight,
    channels: ["sms"],
  });
  assert.equal(o.status, "sent");
  assert.equal(calls.length, 1);
});

test("a channel switched off by the admin is logged as skipped_disabled, and sends once it is switched back on", async () => {
  await prisma.messageTemplate.create({ data: { accountId, triggerKey: NURTURE, channel: "sms", enabled: false } });
  calls = [];
  const [o] = await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "8605550108" }, key("off"), { now: wed });
  assert.equal(o.status, "skipped_disabled");
  assert.equal(calls.length, 0);
  assert.equal((await rowFor(key("off")))?.status, "skipped_disabled");
  await prisma.messageTemplate.deleteMany({ where: { accountId, triggerKey: NURTURE } });
  const [again] = await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "8605550108" }, key("off"), { now: wed });
  assert.equal(again.status, "sent");
  assert.equal(calls.length, 1);
});

test("edited wording is what gets sent", async () => {
  await prisma.messageTemplate.create({ data: { accountId, triggerKey: NURTURE, channel: "sms", body: "Custom for {{customerFirstName}}: {{eventType}}. Reply STOP to opt out.", enabled: true } });
  calls = [];
  await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "8605550109" }, key("custom"), { now: wed });
  assert.match(decodeURIComponent(calls[0].body.replace(/\+/g, " ")), /Custom for Sam: Sweet 16\./);
  await prisma.messageTemplate.deleteMany({ where: { accountId, triggerKey: NURTURE } });
});

test("a token the message may not use blocks it even if the edit was saved", async () => {
  await prisma.messageTemplate.create({ data: { accountId, triggerKey: NURTURE, channel: "sms", body: "Hi {{customerFirstName}} {{gigLink}}", enabled: true } });
  calls = [];
  const [o] = await sendTemplatedMessage(NURTURE, { extra: { customerFirstName: "Sam", gigLink: "https://x" } }, { phone: "8605550110" }, key("bad"), { now: wed });
  assert.equal(o.status, "blocked_missing_field");
  assert.match(o.error ?? "", /gigLink/);
  assert.equal(calls.length, 0);
  await prisma.messageTemplate.deleteMany({ where: { accountId, triggerKey: NURTURE } });
});

test("an email channel that is switched on sends to the webhook with a reference id and the pdf link", async () => {
  calls = [];
  const [o] = await sendTemplatedMessage("staff_contract_signed", { extra: { customerName: "Sam Miller", eventDate: "Sat, Oct 10", contractPdfLink: "https://example.com/c.pdf" } }, { email: "staff@example.com" }, key("mail"), {
    now: wed,
    purpose: { email: "signed-contract-staff" },
  });
  assert.equal(o.channel, "email");
  assert.equal(o.status, "sent");
  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.purpose, "signed-contract-staff");
  assert.equal(sent.referenceId, o.logId);
  assert.equal(sent.pdfUrl, "https://example.com/c.pdf");
  assert.equal(sent.to, "staff@example.com");
});

test("nothing throws when the phone number is bad: it is logged as failed", async () => {
  calls = [];
  const [o] = await sendTemplatedMessage(NURTURE, nurtureCtx, { phone: "12" }, key("badphone"), { now: wed });
  assert.equal(o.status, "failed");
  assert.equal(calls.length, 0);
});
