// Integration tests for the GO contract: the rollout switch, GO's signature
// applied at send, the locked response, signing with and without a second
// signer, and agreements on the original layout answering as before. Needs a
// database; everything made is ZZTEST and deleted at the end with counts.
// Twilio is stubbed; the sign and read calls go through the real router.
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.STOREFRONT_URL = "https://store.test";
process.env.PUBLIC_API_URL = "https://api.test";
delete process.env.EMAIL_WEBHOOK_URL;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { addDays } from "../automation/time.js";
import { prisma } from "../db.js";
import { sendContract } from "../notify.js";
import { publicContractsRouter } from "../routes/contracts.js";

const realFetch = globalThis.fetch;
let texts: string[] = [];
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const ZZ = "ZZTEST";
const made = { bookings: [] as string[], leads: [] as string[] };
let savedSettings: { useGoContract: boolean; authorizedSignerName: string | null; authorizedSignerTitle: string | null } | null = null;
let termsBefore = 0;
let rowsBefore = 0;

async function makeBooking(n: number, details = true) {
  const policy = await prisma.policyVersion.findFirstOrThrow({ where: { accountId }, orderBy: { version: "desc" } });
  const item = await prisma.item.findFirstOrThrow({ where: { accountId, price: { not: null }, units: { some: {} } }, select: { id: true, name: true } });
  const unit = await prisma.unit.findFirstOrThrow({ where: { itemId: item.id }, select: { id: true } });
  const lead = await prisma.lead.create({ data: { accountId, status: "New", source: "manual", customerName: `${ZZ} lead` } });
  made.leads.push(lead.id);
  const eventDate = new Date(`${addDays(new Date().toISOString().slice(0, 10), 200 + n)}T00:00:00Z`);
  let id = "";
  await prisma.$transaction(async (tx) => {
    const b = await tx.booking.create({
      data: {
        accountId, leadId: lead.id, eventDate, customerName: `${ZZ} Client ${n}`, phone: `+1500555030${n}`, email: null, status: "Held", occasion: "Sweet 16", address: "2 Farm Road, Avon, CT", total: 100,
        ...(details ? { venueName: "The Barn", onsiteContactName: "Pat", onsiteContactPhone: "(860) 555-0100", expectedGuests: 80, timeFrom: "2 PM", timeTo: "6 PM", discountPercent: 10 } : {}),
        units: { create: [{ unitId: unit.id, eventDate }] },
      },
    });
    await tx.agreement.create({ data: { accountId, bookingId: b.id, policyVersionId: policy.id, checkboxChecked: true } });
    id = b.id;
  });
  made.bookings.push(id);
  return { id, itemName: item.name };
}
const agreementOf = (bookingId: string) => prisma.agreement.findUniqueOrThrow({ where: { bookingId } });
const get = async (token: string) => {
  const r = await realFetch(`${base}/api/contracts/${token}`);
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const sign = async (token: string, body: unknown) => {
  const r = await realFetch(`${base}/api/contracts/${token}/sign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { useGoContract: true, authorizedSignerName: true, authorizedSignerTitle: true } });
  savedSettings = a;
  termsBefore = await prisma.contractTermsVersion.count({ where: { accountId } });
  rowsBefore = await prisma.contractServiceRow.count({ where: { accountId } });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("twilio")) {
      texts.push(decodeURIComponent(String(init?.body ?? "")).replace(/\+/g, " "));
      return new Response(JSON.stringify({ sid: "SMtest" }), { status: 201 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  const app = express();
  app.use(express.json());
  app.use("/api/contracts", publicContractsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  if (savedSettings) await prisma.account.update({ where: { id: accountId }, data: savedSettings });
  const logs = await prisma.messageLog.deleteMany({ where: { bookingId: { in: made.bookings } } });
  const b = await prisma.booking.deleteMany({ where: { id: { in: made.bookings } } });
  const l = await prisma.lead.deleteMany({ where: { id: { in: made.leads } } });
  const left = {
    bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }),
    leads: await prisma.lead.count({ where: { customerName: { startsWith: ZZ } } }),
    logs: await prisma.messageLog.count({ where: { bookingId: { in: made.bookings } } }),
    docs: await prisma.contractDocument.count({ where: { signedName: { startsWith: ZZ } } }),
  };
  const after = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { useGoContract: true, authorizedSignerName: true } });
  console.log(`# cleanup: ${b.count} bookings, ${l.count} leads, ${logs.count} log rows; remaining ${JSON.stringify(left)}; settings restored ${JSON.stringify(after)}; terms versions ${termsBefore} -> ${await prisma.contractTermsVersion.count({ where: { accountId } })}, service rows ${rowsBefore} -> ${await prisma.contractServiceRow.count({ where: { accountId } })}`);
  assert.deepEqual(left, { bookings: 0, leads: 0, logs: 0, docs: 0 });
  await prisma.$disconnect();
});

test("with the switch off, a new contract is the original layout and answers as before", async () => {
  await prisma.account.update({ where: { id: accountId }, data: { useGoContract: false } });
  const { id } = await makeBooking(1);
  texts = [];
  const sent = await sendContract({ bookingId: id }, "manual");
  assert.equal(sent.linkIsOut, true);
  const a = await agreementOf(id);
  assert.equal(a.format, null);
  assert.equal(a.goSignerName, null);
  const r = await get(a.signingToken as string);
  assert.equal(r.status, 200);
  assert.ok(!("format" in r.json) && !("document" in r.json), "no GO fields on the original layout");
  assert.ok(Array.isArray(r.json.sections) && (r.json.sections as unknown[]).length > 0);
});

test("with the switch on and GO's signer set, sending applies GO's signature and the link serves the locked document", async () => {
  await prisma.account.update({ where: { id: accountId }, data: { useGoContract: true, authorizedSignerName: `${ZZ} Andy`, authorizedSignerTitle: "Owner" } });
  const { id, itemName } = await makeBooking(2);
  texts = [];
  const sent = await sendContract({ bookingId: id }, "manual");
  assert.deepEqual([sent.linkIsOut, sent.stageMoved], [true, true]);
  assert.equal(texts.length, 1);
  const a = await agreementOf(id);
  assert.equal(a.format, "go-v2");
  assert.ok(a.termsVersionId, "the terms version is pinned");
  assert.equal(a.goSignerName, `${ZZ} Andy`);
  assert.ok(a.goSignedAt);
  const r = await get(a.signingToken as string);
  assert.equal(r.status, 200);
  assert.equal(r.json.format, "go-v2");
  assert.equal(r.json.signed, false);
  const d = r.json.document as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(d), ["header", "company", "client", "event", "specialRequests", "services", "payment", "terms", "acceptance", "signatures"]);
  assert.equal(d.client.nameOrg, `${ZZ} Client 2`);
  assert.equal(d.event.venueName, "The Barn");
  assert.equal(d.event.timeFromTo, "2 PM / 6 PM");
  assert.match(String(d.company.logoUrl), /^https:\/\/api\.test\/api\/contracts\/logo\.png\?v=/);
  assert.equal((d.signatures.go as Record<string, unknown>).printedName, `${ZZ} Andy`);
  assert.equal(d.signatures.client, null);
  assert.equal((d.terms.clauses as unknown[]).length, 16);
  const left = d.services.left as { label: string; checked: boolean; details: string | null }[];
  assert.ok(left.length === 11 && (d.services.right as unknown[]).length === 12);
  const rolled = [...left, ...(d.services.right as typeof left)].find((f) => f.checked);
  assert.ok(rolled && rolled.details?.includes(itemName), "the booked item rolled into a row");
  const pay = d.payment as Record<string, unknown>;
  assert.equal(pay.retainerPercent, Number((await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).depositPercentage));
  assert.equal(pay.totalDiscount, Math.floor((pay.subtotal as number) * 0.1 + 0.5));
  // The whole reply is public data: no ids, no notes, no internal columns.
  const raw = JSON.stringify(r.json);
  for (const secret of ["accountId", "leadId", "automationPaused", "itemId", "\"id\":", "contractServices"]) assert.ok(!raw.includes(secret), secret);
});

test("a GO contract cannot be sent until the required details are in", async () => {
  await prisma.account.update({ where: { id: accountId }, data: { useGoContract: true } });
  const { id } = await makeBooking(3, false);
  texts = [];
  const sent = await sendContract({ bookingId: id }, "manual");
  assert.equal(sent.linkIsOut, false);
  assert.match(sent.reason ?? "", /^Fill in the venue name, the on-site contact's name, the on-site contact's phone, the number of expected guests and the event time, from and to under Contract details/);
  assert.equal(texts.length, 0);
  const a = await agreementOf(id);
  assert.deepEqual([a.contractStatus, a.goSignedAt], [null, null]);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id } })).status, "Held");
  const log = await prisma.messageLog.findFirst({ where: { bookingId: id } });
  assert.equal(log?.status, "skipped-not-ready");
});

test("signing with the one checkbox, with and without a second signer; the signed document comes back whole", async () => {
  await prisma.account.update({ where: { id: accountId }, data: { useGoContract: true, authorizedSignerName: `${ZZ} Andy`, authorizedSignerTitle: "Owner" } });
  for (const [n, additional] of [[4, null], [5, "Lee Second"]] as const) {
    const { id } = await makeBooking(n);
    await sendContract({ bookingId: id }, "manual");
    const token = (await agreementOf(id)).signingToken as string;
    const shown = await get(token);
    const hash = shown.json.contentHash as string;
    // The old two-checkbox shape is refused without consent; the one checkbox is enough.
    assert.equal((await sign(token, { fullName: `${ZZ} Pat Client`, contentHash: hash })).status, 400);
    const bad = await sign(token, { fullName: `${ZZ} Pat Client`, esignConsent: true, contentHash: "stale" });
    assert.deepEqual([bad.status, bad.json.reason], [409, "contract-changed"]);
    const ok = await sign(token, { fullName: `${ZZ} Pat Client`, esignConsent: true, consentToElectronicSignature: true, agreeToTerms: true, contentHash: hash, ...(additional ? { additionalSignerName: additional } : {}) });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.format, "go-v2");
    const doc = ok.json.document as Record<string, Record<string, Record<string, unknown> | null>>;
    assert.equal(doc.signatures.client?.printedName, `${ZZ} Pat Client`);
    assert.equal(doc.signatures.additional?.printedName ?? null, additional);
    assert.equal(doc.signatures.go?.printedName, `${ZZ} Andy`);
    const again = await get(token);
    assert.equal(again.json.signed, true);
    assert.equal(again.json.format, "go-v2");
    assert.equal((again.json.document as typeof doc).signatures.client?.printedName, `${ZZ} Pat Client`);
    assert.match(String(again.json.pdfUrl), /\/api\/contracts\/pdf\//);
    const docRow = await prisma.contractDocument.findFirstOrThrow({ where: { agreement: { bookingId: id } } });
    assert.deepEqual([docRow.format, docRow.additionalSignerName], ["go-v2", additional]);
    assert.ok(docRow.pdf.length > 20000, "a real three-page PDF was stored");
    assert.match(docRow.text, /^THIS IS YOUR OFFICIAL CONTRACT/);
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id } })).status, "Signed");
    // The PDF link works and carries the PDF.
    const pdf = await realFetch(`${base}/api/contracts/pdf/${docRow.downloadToken}`);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal((await sign(token, { fullName: `${ZZ} Pat Client`, esignConsent: true, contentHash: hash })).json.reason, "already-signed");
  }
});
