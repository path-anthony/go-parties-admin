// Integration tests for crew bidding against the real database with Twilio
// stubbed. Everything is ZZTEST: one booking with its gigs, offers and
// questions (deleted with the booking), four crew members with fake 500
// numbers, and the message log rows about those gigs. All removed at the end
// and the counts asserted.
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.STOREFRONT_URL = "https://store.test";
delete process.env.EMAIL_WEBHOOK_URL;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { addDays, atEastern } from "../automation/time.js";
import { acceptOffer, declineBid, extendDeadline, getBidPage, inviteBids, newToken, notifyAccepted, offerState, parseTimes, parseTown, rangeFlag, submitBid, tokenExpiresAt, BidError } from "../bids.js";
import { prisma } from "../db.js";
import { makeBidReadLimiter, makeBidWriteLimiter } from "../rateLimit.js";
import { makeBidsRouter } from "../routes/bids.js";

const realFetch = globalThis.fetch;
let twilioCalls: string[] = [];
const SKILL = "ZZTEST Skill";
const CUSTOMER = "ZZTEST Customer";
const CUSTOMER_PHONE = "+15005559999";
const CUSTOMER_EMAIL = "zztest-customer@example.invalid";
const ADDRESS = "12 Main St, Farmington, CT 06032";
let accountId = "";
let bookingId = "";
let server: ReturnType<typeof app.listen>;
let base = "";
const app = express();
app.use(express.json());
app.use("/api/bids", makeBidsRouter());
const crew: { id: string }[] = [];
const gigs: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
type R = Omit<Response, "json"> & { json(): Promise<J> };
const get = (t: string) => realFetch(`${base}/api/bids/${t}`) as Promise<R>;
const put = (t: string, body: unknown) => realFetch(`${base}/api/bids/${t}/bid`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as Promise<R>;
const post = (t: string, path: string, body?: unknown) => realFetch(`${base}/api/bids/${t}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }) as Promise<R>;

async function newGig(days = 10) {
  const g = await prisma.gig.create({ data: { accountId, bookingId, itemName: "ZZTEST Item", skill: SKILL, eventDate: new Date(`${addDays(new Date().toISOString().slice(0, 10), days)}T00:00:00Z`) } });
  gigs.push(g.id);
  return g;
}
const future = (h = 48) => new Date(Date.now() + h * 3_600_000);
const offerOf = async (gigId: string, crewId: string) => prisma.gigOffer.findFirstOrThrow({ where: { gigId, crewMemberId: crewId } });

before(async () => {
  accountId = (await getDefaultAccount()).id;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("twilio")) {
      twilioCalls.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ sid: "SMtest" }), { status: 201 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const policy = await prisma.policyVersion.findFirstOrThrow({ where: { accountId }, orderBy: { version: "desc" } });
  const eventDate = new Date(`${addDays(new Date().toISOString().slice(0, 10), 10)}T00:00:00Z`);
  await prisma.$transaction(async (tx) => {
    const b = await tx.booking.create({ data: { accountId, eventDate, eventTime: "2 PM to 6 PM", address: ADDRESS, occasion: "Sweet 16", customerName: CUSTOMER, phone: CUSTOMER_PHONE, email: CUSTOMER_EMAIL } });
    await tx.agreement.create({ data: { accountId, bookingId: b.id, policyVersionId: policy.id, checkboxChecked: false } });
    bookingId = b.id;
  });
  for (let i = 1; i <= 4; i++) {
    crew.push(await prisma.crewMember.create({ data: { accountId, name: `ZZTEST Crew${i} Last`, phone: `+1500555011${i}`, skills: [SKILL], smsConsent: i !== 4 } }));
  }
});

after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  await prisma.messageLog.deleteMany({ where: { gigId: { in: gigs } } });
  const b = await prisma.booking.deleteMany({ where: { id: bookingId } });
  const c = await prisma.crewMember.deleteMany({ where: { id: { in: crew.map((m) => m.id) } } });
  const left = { gigs: await prisma.gig.count({ where: { id: { in: gigs } } }), offers: await prisma.gigOffer.count({ where: { gigId: { in: gigs } } }), logs: await prisma.messageLog.count({ where: { gigId: { in: gigs } } }) };
  console.log(`# cleanup: ${b.count} booking, ${c.count} crew, remaining ${JSON.stringify(left)}`);
  assert.deepEqual(left, { gigs: 0, offers: 0, logs: 0 });
  await prisma.$disconnect();
});

test("prefill reads times and town from the booking, or leaves them empty", () => {
  assert.deepEqual(parseTimes("2 PM to 6 PM"), { start: "2 PM", end: "6 PM" });
  assert.deepEqual(parseTimes("noon to 4"), { start: "12 PM", end: "4 PM" });
  assert.deepEqual(parseTimes("6-10pm"), { start: "6 PM", end: "10 PM" });
  assert.deepEqual(parseTimes("afternoon"), { start: null, end: null });
  assert.equal(parseTown(ADDRESS), "Farmington");
  assert.equal(parseTown("Somewhere near the park"), null);
});

test("range flags", () => {
  assert.equal(rangeFlag(400, 250, 350), "above range");
  assert.equal(rangeFlag(200, 250, 350), "below range");
  assert.equal(rangeFlag(300, 250, 350), null);
});

test("inviting sets the range, prefills, gives each person their own link and texts them", async () => {
  const g = await newGig();
  twilioCalls = [];
  const r = await inviteBids(g.id, { crewMemberIds: [crew[0].id, crew[1].id, crew[2].id], payMin: 250, payMax: 350, deadlineAt: future() });
  assert.equal(r.offered, 3);
  assert.ok(r.messages.every((m) => m.status === "sent"));
  const row = await prisma.gig.findUniqueOrThrow({ where: { id: g.id } });
  assert.deepEqual([row.status, row.payMin, row.payMax, row.eventType, row.startTime, row.endTime, row.town], ["Offered", 250, 350, "Sweet 16", "2 PM", "6 PM", "Farmington"]);
  const offers = await prisma.gigOffer.findMany({ where: { gigId: g.id } });
  assert.equal(new Set(offers.map((o) => o.token)).size, 3);
  const text = decodeURIComponent(twilioCalls[0]).replace(/\+/g, " ");
  assert.match(text, /https:\/\/store\.test\/bid\/[\w-]{20,}/);
  assert.match(text, /\$250 to \$350/);
  assert.match(text, /Farmington/);
  // The company name is spelled with a "!"; nothing else in the text may be.
  assert.doesNotMatch(text.replace("GO! Event Group", "GO Event Group"), /!|—/);
  // Inviting again skips people who already have an offer.
  assert.equal((await inviteBids(g.id, { crewMemberIds: [crew[0].id], payMin: 250, payMax: 350, deadlineAt: future() })).offered, 0);
});

test("with STOREFRONT_URL unset the invite is blocked with that reason, not sent broken", async () => {
  const g = await newGig();
  const saved = process.env.STOREFRONT_URL;
  delete process.env.STOREFRONT_URL;
  twilioCalls = [];
  try {
    const r = await inviteBids(g.id, { crewMemberIds: [crew[0].id], payMin: 100, payMax: 200, deadlineAt: future() });
    assert.equal(r.messages[0].status, "blocked_missing_field");
    assert.match(r.messages[0].error ?? "", /STOREFRONT_URL/);
    assert.equal(twilioCalls.length, 0);
  } finally {
    process.env.STOREFRONT_URL = saved;
  }
});

test("the page before acceptance never carries private fields", async () => {
  const g = await newGig();
  await inviteBids(g.id, { crewMemberIds: [crew[0].id], payMin: 250, payMax: 350, deadlineAt: future() });
  const o = await offerOf(g.id, crew[0].id);
  for (const state of ["open", "bid_submitted", "not_selected", "declined"] as const) {
    if (state === "bid_submitted") await prisma.gigOffer.update({ where: { id: o.id }, data: { bidAmount: 300, bidSubmittedAt: new Date() } });
    if (state === "not_selected") await prisma.gigOffer.update({ where: { id: o.id }, data: { status: "Not Selected" } });
    if (state === "declined") await prisma.gigOffer.update({ where: { id: o.id }, data: { status: "Declined" } });
    const res = await get(o.token as string);
    assert.equal(res.status, 200);
    const raw = await res.text();
    const json: J = JSON.parse(raw);
    assert.equal(json.state, state);
    assert.deepEqual(Object.keys(json).sort(), ["deadlineAt", "eventDate", "eventType", "endTime", "guestCount", "myBid", "payRange", "role", "startTime", "state", "town"].sort());
    for (const banned of ["address", "arrivalNotes", "contactPhone", "crewFirstName", "questions", "customerName", "customerPhone", "customerEmail", "bookingId", "id"]) assert.ok(!(banned in json), `${banned} leaked in ${state}`);
    for (const secret of [CUSTOMER, CUSTOMER_PHONE, CUSTOMER_EMAIL, bookingId, "12 Main St", "Crew1"]) assert.ok(!raw.includes(secret), `${secret} leaked in ${state}`);
  }
});

test("bids: validation, edits until the deadline, then locked", async () => {
  const g = await newGig();
  await inviteBids(g.id, { crewMemberIds: [crew[0].id, crew[1].id], payMin: 250, payMax: 350, deadlineAt: future() });
  const a = (await offerOf(g.id, crew[0].id)).token as string;
  for (const bad of [{ amount: 1.5 }, { amount: -5 }, { amount: "300" }, { amount: 0 }, {}, { amount: 300, note: "x".repeat(201) }]) {
    const res = await put(a, bad);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, "bid-invalid");
  }
  let res = await put(a, { amount: 300, note: "I can bring a second speaker" });
  assert.equal(res.status, 200);
  let json: J = await res.json();
  assert.equal(json.state, "bid_submitted");
  assert.equal(json.myBid.amount, 300);
  res = await put(a, { amount: 500 });
  assert.equal((await res.json()).myBid.amount, 500, "out-of-range bids are allowed and editable");
  // Deadline passes: the bid stands but can't change; a new bid can't be made.
  await prisma.gigOffer.updateMany({ where: { gigId: g.id }, data: { deadlineAt: new Date(Date.now() - 60_000) } });
  res = await put(a, { amount: 260 });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, "deadline-passed");
  assert.equal((await offerOf(g.id, crew[0].id)).bidAmount, 500);
  const b = (await offerOf(g.id, crew[1].id)).token as string;
  assert.equal((await put(b, { amount: 300 })).status, 409);
  assert.equal((await (await get(b)).json()).state, "expired");
  assert.equal((await (await get(a)).json()).state, "bid_submitted");
  // Extending the deadline reopens editing.
  await extendDeadline(g.id, future());
  assert.equal((await put(a, { amount: 260 })).status, 200);
});

test("declining works and reopens the gig when nobody is left", async () => {
  const g = await newGig();
  await inviteBids(g.id, { crewMemberIds: [crew[0].id], payMin: 250, payMax: 350, deadlineAt: future() });
  const t = (await offerOf(g.id, crew[0].id)).token as string;
  const res = await post(t, "decline");
  assert.equal((await res.json()).state, "declined");
  assert.equal((await prisma.gig.findUniqueOrThrow({ where: { id: g.id } })).status, "Needs Crew");
  assert.equal((await put(t, { amount: 300 })).status, 409);
});

test("accepting: winner accepted, others not selected, declined stay declined, gig filled, texts go out", async () => {
  const g = await newGig();
  await inviteBids(g.id, { crewMemberIds: [crew[0].id, crew[1].id, crew[2].id, crew[3].id], payMin: 250, payMax: 350, deadlineAt: future() });
  const [o0, o1, o2, o3] = await Promise.all(crew.map((c) => offerOf(g.id, c.id)));
  await put(o0.token as string, { amount: 300 });
  await put(o1.token as string, { amount: 280 });
  await post(o3.token as string, "decline");
  twilioCalls = [];
  const r = await acceptOffer(g.id, o0.id);
  await notifyAccepted(r);
  const after = await prisma.gigOffer.findMany({ where: { gigId: g.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(after.map((o) => o.status).sort(), ["Accepted", "Declined", "Not Selected", "Not Selected"]);
  assert.equal(after.find((o) => o.id === o3.id)?.status, "Declined");
  const gig = await prisma.gig.findUniqueOrThrow({ where: { id: g.id } });
  assert.deepEqual([gig.status, gig.filledById], ["Filled", crew[0].id]);
  const win = await prisma.messageLog.findUnique({ where: { idempotencyKey: `bid_accepted:${o0.id}:sms` } });
  assert.equal(win?.status, "sent");
  assert.match(win?.body ?? "", /\$300/);
  assert.match(win?.body ?? "", /12 Main St/);
  for (const o of [o1, o2]) assert.equal((await prisma.messageLog.findUnique({ where: { idempotencyKey: `bid_not_selected:${o.id}:sms` } }))?.status, "sent");
  assert.equal(await prisma.messageLog.count({ where: { idempotencyKey: `bid_not_selected:${o3.id}:sms` } }), 0, "a decliner is not told they were not selected");
  assert.equal(twilioCalls.length, 3);
  // A second accept is refused with the holder's name.
  await assert.rejects(acceptOffer(g.id, o1.id), (e: unknown) => e instanceof BidError && e.reason === "already-filled" && /Crew1/.test(e.message));
  // The winner's page now shows the rest, and they can confirm and ask.
  const page = await (await get(o0.token as string)).json();
  assert.equal(page.state, "accepted");
  assert.equal(page.address, ADDRESS);
  assert.equal(page.crewFirstName, "ZZTEST");
  assert.match(page.contactPhone, /^\+1\d{10}$/);
  assert.equal(page.confirmedAt, null);
  assert.deepEqual(page.questions, []);
  const conf = await (await post(o0.token as string, "confirm")).json();
  assert.ok(conf.confirmedAt);
  assert.equal((await (await get(o0.token as string)).json()).confirmedAt, conf.confirmedAt);
  assert.deepEqual(await (await post(o0.token as string, "question", { text: "Is there parking on site?" })).json(), { ok: true });
  assert.equal((await (await get(o0.token as string)).json()).questions[0].text, "Is there parking on site?");
  assert.equal((await post(o0.token as string, "question", { text: "" })).status, 400);
  // Losers can't see the address, confirm or ask.
  const lost = await (await get(o1.token as string)).json();
  assert.equal(lost.state, "not_selected");
  assert.ok(!("address" in lost));
  assert.equal((await post(o1.token as string, "confirm")).status, 409);
  assert.equal((await post(o1.token as string, "question", { text: "hi" })).status, 409);
  assert.equal((await put(o1.token as string, { amount: 1 })).status, 409);
});

test("a manual accept with no bid says the agreed rate", async () => {
  const g = await newGig();
  await inviteBids(g.id, { crewMemberIds: [crew[0].id], payMin: 250, payMax: 350, deadlineAt: future() });
  const o = await offerOf(g.id, crew[0].id);
  await notifyAccepted(await acceptOffer(g.id, o.id));
  const log = await prisma.messageLog.findUnique({ where: { idempotencyKey: `bid_accepted:${o.id}:sms` } });
  assert.equal(log?.status, "sent");
  assert.match(log?.body ?? "", /Pay: the agreed rate/);
});

test("race: an accept and a bid edit never both win", async () => {
  for (let round = 0; round < 5; round++) {
    const g = await newGig();
    await inviteBids(g.id, { crewMemberIds: [crew[0].id], payMin: 250, payMax: 350, deadlineAt: future() });
    const o = await offerOf(g.id, crew[0].id);
    await put(o.token as string, { amount: 300 });
    const [edit, accept] = await Promise.allSettled([submitBid(o.token as string, { amount: 320 }), acceptOffer(g.id, o.id)]);
    assert.equal(accept.status, "fulfilled");
    const final = await prisma.gigOffer.findUniqueOrThrow({ where: { id: o.id } });
    assert.equal(final.status, "Accepted");
    if (edit.status === "fulfilled") assert.equal(final.bidAmount, 320, "the edit landed before the accept");
    else {
      assert.ok(edit.reason instanceof BidError && edit.reason.reason === "already-filled");
      assert.equal(final.bidAmount, 300, "the edit lost and changed nothing");
    }
  }
});

test("race: two accepts on one gig, exactly one wins", async () => {
  for (let round = 0; round < 3; round++) {
    const g = await newGig();
    await inviteBids(g.id, { crewMemberIds: [crew[0].id, crew[1].id], payMin: 250, payMax: 350, deadlineAt: future() });
    const [a, b] = await Promise.all([offerOf(g.id, crew[0].id), offerOf(g.id, crew[1].id)]);
    const results = await Promise.allSettled([acceptOffer(g.id, a.id), acceptOffer(g.id, b.id)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal((rejected.reason as BidError).reason, "already-filled");
    assert.equal(await prisma.gigOffer.count({ where: { gigId: g.id, status: "Accepted" } }), 1);
    assert.equal(await prisma.gigOffer.count({ where: { gigId: g.id, status: "Not Selected" } }), 1);
  }
});

test("links stop working 2 days after the gig date, and unknown tokens are 404", async () => {
  const g = await newGig(0);
  await inviteBids(g.id, { crewMemberIds: [crew[0].id], payMin: 250, payMax: 350, deadlineAt: future() });
  const o = await offerOf(g.id, crew[0].id);
  const t = o.token as string;
  const dayText = g.eventDate.toISOString().slice(0, 10);
  assert.ok(await getBidPage(t, atEastern(addDays(dayText, 2), 23, 59)), "still works late on day +2");
  assert.equal(await getBidPage(t, atEastern(addDays(dayText, 3), 0, 1)), null, "gone on day +3");
  assert.equal(tokenExpiresAt(g.eventDate).getTime(), atEastern(addDays(dayText, 3), 0).getTime());
  assert.equal((await get(newToken())).status, 404);
  assert.equal((await get("short")).status, 404);
});

test("state machine", () => {
  const now = new Date();
  const past = new Date(now.getTime() - 1000);
  const soon = new Date(now.getTime() + 1000);
  const st = (o: Partial<{ status: string; bidAmount: number | null; deadlineAt: Date | null }>, gig = "Offered") => offerState({ status: "Sent", bidAmount: null, deadlineAt: soon, ...o }, gig, now);
  assert.equal(st({}), "open");
  assert.equal(st({ bidAmount: 5 }), "bid_submitted");
  assert.equal(st({ bidAmount: 5, deadlineAt: past }), "bid_submitted");
  assert.equal(st({ deadlineAt: past }), "expired");
  assert.equal(st({ status: "Accepted" }), "accepted");
  assert.equal(st({ status: "Not Selected" }), "not_selected");
  assert.equal(st({ status: "Declined" }), "declined");
  assert.equal(st({}, "Cancelled"), "expired");
});

test("the write endpoints are rate limited with reason rate-limited", async () => {
  const tiny = express();
  tiny.use(express.json());
  tiny.use("/api/bids", makeBidsRouter({ read: makeBidReadLimiter(2), write: makeBidWriteLimiter(2) }));
  const s = tiny.listen(0);
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/bids/${newToken()}`;
  try {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await realFetch(`${url}/decline`, { method: "POST" })).status);
    assert.deepEqual(codes, [404, 404, 429]);
    const limited = await realFetch(`${url}/decline`, { method: "POST" });
    assert.equal(((await limited.json()) as J).reason, "rate-limited");
    const reads = [];
    for (let i = 0; i < 3; i++) reads.push((await realFetch(url)).status);
    assert.deepEqual(reads, [404, 404, 429]);
  } finally {
    s.close();
  }
});

test("declineBid on an unknown link is a 404 error object", async () => {
  await assert.rejects(declineBid(newToken()), (e: unknown) => e instanceof BidError && e.status === 404);
});
