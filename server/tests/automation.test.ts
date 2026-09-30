// Integration tests for the scheduler's edges, against the real database
// with Twilio and the email webhook stubbed so nothing can be sent. Rows
// written here carry an idempotency key starting "test:" or use the fake
// 500 numbers, and are deleted at the end.
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.EMAIL_WEBHOOK_URL = "http://stub.invalid/hook";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getDefaultAccount } from "../account.js";
import { runAutomation } from "../automation/runner.js";
import { prisma } from "../db.js";
import { sendTemplatedMessage } from "../sendTemplated.js";

const realFetch = globalThis.fetch;
let calls: string[] = [];
let twilioAnswer: () => Response = () => new Response(JSON.stringify({ sid: "SMtest" }), { status: 201 });
const RUN = `test:auto:${Date.now()}`;
const NURTURE = "lead_nurture_day10";
const ctx = { extra: { customerFirstName: "Sam", eventType: "Sweet 16" } };
const noon = new Date("2026-09-30T16:00:00Z"); // Wednesday noon Eastern
let accountId = "";
const PHONES = ["+15005550101", "+15005550102", "+15005550103"];

before(async () => {
  accountId = (await getDefaultAccount()).id;
  assert.equal(await prisma.messageTemplate.count({ where: { accountId, triggerKey: NURTURE } }), 0);
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return String(url).includes("twilio") ? twilioAnswer() : new Response("{}", { status: 200 });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await prisma.messageLog.deleteMany({ where: { idempotencyKey: { startsWith: RUN } } });
  await prisma.smsOptOut.deleteMany({ where: { accountId, phone: { in: PHONES } } });
  await prisma.$disconnect();
});

test("a dry run sends nothing and writes nothing", async () => {
  calls = [];
  const notTests = { NOT: { idempotencyKey: { startsWith: "test:" } } };
  const before = { logs: await prisma.messageLog.count({ where: notTests }), runs: await prisma.automationRun.count() };
  const result = await runAutomation({ dryRun: true, source: "admin", now: noon });
  assert.equal(result.dryRun, true);
  assert.equal(calls.length, 0);
  assert.equal(await prisma.messageLog.count({ where: notTests }), before.logs);
  assert.equal(await prisma.automationRun.count(), before.runs);
  for (const line of result.lines) assert.match(line.result, /^would/);
});

test("a number that opted out is skipped before Twilio is called, on every journey", async () => {
  await prisma.smsOptOut.create({ data: { accountId, phone: PHONES[0], source: "staff" } });
  calls = [];
  const [o] = await sendTemplatedMessage(NURTURE, ctx, { phone: PHONES[0] }, `${RUN}:optout`, { now: noon });
  assert.equal(o.status, "skipped_opted_out");
  assert.equal(calls.length, 0);
  // Terminal: asking again does nothing.
  const [again] = await sendTemplatedMessage(NURTURE, ctx, { phone: PHONES[0] }, `${RUN}:optout`, { now: noon });
  assert.equal(again.duplicate, true);
  assert.equal(calls.length, 0);
});

test("Twilio answering 21610 records the opt-out, and the next text never reaches Twilio", async () => {
  twilioAnswer = () => new Response(JSON.stringify({ code: 21610, message: "unsubscribed" }), { status: 400 });
  calls = [];
  const [o] = await sendTemplatedMessage(NURTURE, ctx, { phone: PHONES[1] }, `${RUN}:stop`, { now: noon });
  assert.equal(o.status, "skipped_opted_out");
  assert.equal(calls.length, 1);
  const row = await prisma.smsOptOut.findUnique({ where: { accountId_phone: { accountId, phone: PHONES[1] } } });
  assert.equal(row?.source, "twilio-21610");
  const [next] = await sendTemplatedMessage(NURTURE, ctx, { phone: PHONES[1] }, `${RUN}:stop2`, { now: noon });
  assert.equal(next.status, "skipped_opted_out");
  assert.equal(calls.length, 1);
  twilioAnswer = () => new Response(JSON.stringify({ sid: "SMtest" }), { status: 201 });
});

test("a failing send is tried 3 times, then failed_final, then left alone", async () => {
  twilioAnswer = () => new Response(JSON.stringify({ message: "boom" }), { status: 500 });
  calls = [];
  const k = `${RUN}:retry`;
  const statuses: string[] = [];
  for (let i = 0; i < 4; i++) {
    const [o] = await sendTemplatedMessage(NURTURE, ctx, { phone: PHONES[2] }, k, { now: noon });
    statuses.push(o.duplicate ? "duplicate" : o.status);
  }
  assert.deepEqual(statuses, ["failed", "failed", "failed_final", "duplicate"]);
  assert.equal(calls.length, 3);
  const row = await prisma.messageLog.findUnique({ where: { idempotencyKey: `${k}:sms` } });
  assert.equal(row?.attempts, 3);
  assert.equal(row?.status, "failed_final");
  twilioAnswer = () => new Response(JSON.stringify({ sid: "SMtest" }), { status: 201 });
});

test("a successful send records when it went", async () => {
  const [o] = await sendTemplatedMessage(NURTURE, ctx, { phone: "+15005550104" }, `${RUN}:ok`, { now: noon });
  assert.equal(o.status, "sent");
  const row = await prisma.messageLog.findUnique({ where: { idempotencyKey: `${RUN}:ok:sms` } });
  assert.equal(row?.attempts, 1);
  assert.ok(row?.sentAt);
});
