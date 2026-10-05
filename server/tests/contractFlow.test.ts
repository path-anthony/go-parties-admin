// Integration tests for contract sending and the design request
// acknowledgement, with Twilio stubbed so nothing can really be sent. They
// need a database. Everything they create is ZZTEST (bookings, leads, design
// requests, with fake 500 numbers) and is deleted at the end, with the counts
// asserted. The rules themselves are tested without a database in
// blockL.test.ts; this checks that the database ends up in the state they say.
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.STOREFRONT_URL = "https://store.test";
delete process.env.EMAIL_WEBHOOK_URL;

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getDefaultAccount } from "../account.js";
import { addDays } from "../automation/time.js";
import { prepareContract } from "../contracts.js";
import { prisma } from "../db.js";
import { createDirectBooking } from "../directBooking.js";
import { sendContract } from "../notify.js";

const realFetch = globalThis.fetch;
let texts: string[] = [];
let accountId = "";
const ZZ = "ZZTEST";
const made = { bookings: [] as string[], leads: [] as string[], requests: [] as string[] };
const day = (n: number) => new Date(`${addDays(new Date().toISOString().slice(0, 10), n)}T00:00:00Z`);

async function makeBooking(opts: { phone?: string | null; status?: string; n: number }) {
  const policy = await prisma.policyVersion.findFirstOrThrow({ where: { accountId }, orderBy: { version: "desc" } });
  const lead = await prisma.lead.create({ data: { accountId, status: "New", source: "manual", customerName: `${ZZ} lead` } });
  made.leads.push(lead.id);
  let id = "";
  await prisma.$transaction(async (tx) => {
    const b = await tx.booking.create({ data: { accountId, leadId: lead.id, eventDate: day(40 + opts.n), customerName: `${ZZ} Customer`, phone: opts.phone === undefined ? `+1500555020${opts.n}` : opts.phone, email: null, status: opts.status ?? "Held", total: 500 } });
    await tx.agreement.create({ data: { accountId, bookingId: b.id, policyVersionId: policy.id, checkboxChecked: true } });
    id = b.id;
  });
  made.bookings.push(id);
  return id;
}
const agreementOf = (bookingId: string) => prisma.agreement.findUniqueOrThrow({ where: { bookingId } });
const stageOf = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;

before(async () => {
  accountId = (await getDefaultAccount()).id;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("twilio")) {
      texts.push(decodeURIComponent(String(init?.body ?? "")).replace(/\+/g, " "));
      return new Response(JSON.stringify({ sid: "SMtest" }), { status: 201 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  const logs = await prisma.messageLog.deleteMany({ where: { OR: [{ bookingId: { in: made.bookings } }, { designRequestId: { in: made.requests } }] } });
  const r = await prisma.designRequest.deleteMany({ where: { id: { in: made.requests } } });
  const b = await prisma.booking.deleteMany({ where: { id: { in: made.bookings } } });
  const l = await prisma.lead.deleteMany({ where: { id: { in: made.leads } } });
  const left = {
    bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }),
    leads: await prisma.lead.count({ where: { customerName: { startsWith: ZZ } } }),
    requests: await prisma.designRequest.count({ where: { customerName: { startsWith: ZZ } } }),
    logs: await prisma.messageLog.count({ where: { OR: [{ bookingId: { in: made.bookings } }, { designRequestId: { in: made.requests } }] } }),
  };
  console.log(`# cleanup: ${b.count} bookings, ${l.count} leads, ${r.count} design requests, ${logs.count} log rows; remaining ${JSON.stringify(left)}`);
  assert.deepEqual(left, { bookings: 0, leads: 0, requests: 0, logs: 0 });
  await prisma.$disconnect();
});

test("previewing or preparing a contract never marks it sent or starts the reminder clock", async () => {
  const id = await makeBooking({ n: 1 });
  texts = [];
  const prepared = await prepareContract({ bookingId: id });
  assert.match(prepared.link, /^https:\/\/store\.test\/sign\//);
  const again = await prepareContract({ bookingId: id });
  assert.equal(again.link, prepared.link, "preparing twice gives the same link");
  const a = await agreementOf(id);
  assert.equal(a.contractStatus, null);
  assert.equal(a.contractSentAt, null);
  assert.equal(await stageOf(id), "Held");
  assert.equal(texts.length, 0);
});

test("Send contract link on a Held booking: one text, contract Sent, clock started, stage Contract Sent", async () => {
  const id = await makeBooking({ n: 2 });
  texts = [];
  const sent = await sendContract({ bookingId: id }, "manual");
  assert.deepEqual([sent.action, sent.linkIsOut, sent.stageMoved, sent.reason], ["send-link", true, true, null]);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /store\.test\/sign\//);
  const a = await agreementOf(id);
  assert.equal(a.contractStatus, "Sent");
  assert.ok(a.contractSentAt);
  assert.equal(await stageOf(id), "Contract Sent");
  const lead = await prisma.booking.findUniqueOrThrow({ where: { id }, select: { leadId: true } });
  assert.equal(await prisma.leadActivity.count({ where: { leadId: lead.leadId as string, text: { contains: "Stage moved to Contract Sent" } } }), 1);
  // Setting the stage afterwards records it and does not text again.
  texts = [];
  const stage = await sendContract({ bookingId: id }, "stage");
  assert.deepEqual([stage.action, stage.linkIsOut, stage.stageMoved], ["nothing", true, false]);
  assert.equal(texts.length, 0);
  assert.equal((await agreementOf(id)).contractSentAt?.getTime(), a.contractSentAt?.getTime(), "the clock keeps its first start");
});

test("setting the stage to Contract Sent sends once; a link that cannot go changes nothing", async () => {
  const ok = await makeBooking({ n: 3 });
  texts = [];
  const first = await sendContract({ bookingId: ok }, "stage");
  assert.deepEqual([first.action, first.linkIsOut, first.stageMoved], ["send-link", true, true]);
  assert.equal(texts.length, 1);
  const noContact = await makeBooking({ n: 4, phone: null });
  texts = [];
  const failed = await sendContract({ bookingId: noContact }, "stage");
  assert.equal(failed.linkIsOut, false);
  assert.ok(failed.reason && failed.reason.length > 0);
  assert.equal(texts.length, 0);
  const a = await agreementOf(noContact);
  assert.deepEqual([a.contractStatus, a.contractSentAt], [null, null]);
  assert.equal(await stageOf(noContact), "Held");
});

test("a signed contract is never resent by a stage change; the button sends the signed copy", async () => {
  const id = await makeBooking({ n: 5, status: "Signed" });
  await prisma.agreement.update({ where: { bookingId: id }, data: { contractStatus: "Signed", signingToken: `zz-${id}`, contractUrl: "https://api.test/api/contracts/pdf/zzsigned", contractSentAt: new Date() } });
  texts = [];
  const stage = await sendContract({ bookingId: id }, "stage");
  assert.deepEqual([stage.action, stage.signed, stage.linkIsOut, stage.stageMoved], ["nothing", true, false, false]);
  assert.equal(texts.length, 0);
  const manual = await sendContract({ bookingId: id }, "manual");
  assert.equal(manual.action, "send-signed-copy");
  assert.equal(texts.length, 1);
  assert.match(texts[0], /zzsigned/);
  assert.equal(await stageOf(id), "Signed");
  assert.equal((await agreementOf(id)).contractStatus, "Signed");
});

test("a storefront design request records the agreement and texts the acknowledgement once", async () => {
  const item = await prisma.item.findFirstOrThrow({ where: { accountId, price: { not: null } }, select: { id: true } });
  texts = [];
  const input = {
    staff: false,
    occasion: "Wedding",
    agreed: true,
    name: `${ZZ} Bride`,
    contact: { phone: "+15005550209", email: null },
    customer: null,
    itemIds: [item.id],
    date: day(60),
    dateText: day(60).toISOString().slice(0, 10),
    eventTime: null,
    address: null,
    selections: new Map(),
    packageId: null,
    request: { ip: "203.0.113.50", userAgent: "ZZTEST-agent/1.0" },
  } as Parameters<typeof createDirectBooking>[0];
  const res = await createDirectBooking(input);
  assert.equal(res.status, 202);
  const body = res.body as { designRequestId: string; reviewRequired: boolean };
  made.requests.push(body.designRequestId);
  const a = await prisma.agreement.findUniqueOrThrow({ where: { designRequestId: body.designRequestId }, include: { policyVersion: true } });
  assert.equal(a.checkboxChecked, true);
  assert.match(a.agreedIpHash ?? "", /^[0-9a-f]{32}$/);
  assert.equal(a.agreedUserAgent, "ZZTEST-agent/1.0");
  assert.ok(a.policyVersion.version >= 1 && a.agreedAt);
  // The acknowledgement is sent after the reply; give it a moment.
  for (let i = 0; i < 40 && texts.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Hi ZZTEST, this is GO! Event Group\. Big events get a personal look\. We'll reach out within one business day\./);
  const log = await prisma.messageLog.findFirstOrThrow({ where: { designRequestId: body.designRequestId, channel: "sms" } });
  assert.deepEqual([log.triggerKey, log.status, log.journey], ["design_request_received", "sent", "client"]);
  // A request staff enter gets no acknowledgement and no agreement of its own.
  texts = [];
  const staffRes = await createDirectBooking({ ...input, staff: true, name: `${ZZ} Staff Entered`, request: undefined });
  assert.equal(staffRes.status, 202);
  const staffId = (staffRes.body as { designRequestId: string }).designRequestId;
  made.requests.push(staffId);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(texts.length, 0);
  assert.equal(await prisma.agreement.count({ where: { designRequestId: staffId } }), 0);
});
