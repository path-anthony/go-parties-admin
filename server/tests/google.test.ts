// Google Calendar sync, with every Google call mocked (setGoogleFetch). The
// pure parts (state signing, encryption, payloads) need nothing; the sync
// parts need the database and use ZZTEST bookings, cleaned up at the end
// with counts. No real Google request is ever made here.
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.STOREFRONT_URL = "https://store.test";
process.env.PUBLIC_API_URL = "https://api.test";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getDefaultAccount } from "../account.js";
import { addDays } from "../automation/time.js";
import { prisma } from "../db.js";
import { GoogleError, REDIRECT_URI, SCOPES, authUrl, setGoogleFetch } from "../google/client.js";
import { beginConnect, finishConnect, spendState } from "../google/connection.js";
import { decryptToken, encryptToken, encryptionKey, signState, verifyState } from "../google/crypto.js";
import { eventTimes, internalEventPayload, inviteEventPayload, syncHash, type BookingForCalendar } from "../google/payload.js";
import { reachesStage, reconcileCalendar, syncBooking } from "../google/sync.js";

// ---- a fake Google ----------------------------------------------------------------
type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
const events = new Map<string, { calendar: string; payload: Record<string, unknown> }>();
let nextId = 1;
let refreshFails: "no" | "invalid_grant" = "no";
let failInserts = false;

function fakeGoogle(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const body = init?.body ? (typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init.body)))) : null;
  calls.push({ method, url, body });
  const json = (status: number, data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    if (body?.grant_type === "authorization_code") return json(200, { access_token: "at-1", refresh_token: "rt-secret-value", expires_in: 3600 });
    if (refreshFails === "invalid_grant") return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    return json(200, { access_token: "at-2", expires_in: 3600 });
  }
  if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json(200, {});
  if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return json(200, { email: "info@thegoeventgroup.com" });
  if (url.includes("/users/me/calendarList")) return json(200, { items: [{ id: "primary-cal", summary: "info@thegoeventgroup.com", primary: true, accessRole: "owner" }, { id: "invites-cal", summary: "GO Client Invites", accessRole: "owner" }] });
  const m = /\/calendars\/([^/]+)\/events(?:\/([^?]+))?/.exec(url);
  if (m) {
    const calendar = decodeURIComponent(m[1]);
    const id = m[2] ? decodeURIComponent(m[2]) : null;
    if (method === "POST") {
      if (failInserts) return json(503, { error: { status: "UNAVAILABLE", message: "Backend Error" } });
      const newId = `evt-${nextId++}`;
      events.set(newId, { calendar, payload: body });
      return json(200, { id: newId });
    }
    if (method === "PUT" && id) {
      if (!events.has(id)) return json(404, { error: { status: "NOT_FOUND", message: "Not Found" } });
      events.set(id, { calendar, payload: body });
      return json(200, { id });
    }
    if (method === "DELETE" && id) {
      const existed = events.delete(id);
      return existed ? Promise.resolve(new Response(null, { status: 204 })) : json(410, { error: { status: "GONE", message: "deleted" } });
    }
    if (method === "GET" && id) return events.has(id) ? json(200, { id, status: "confirmed" }) : json(404, {});
  }
  return json(500, { error: "unexpected" });
}

let accountId = "";
let saved: Record<string, unknown> | null = null;
const ZZ = "ZZTEST";
const made = { bookings: [] as string[], leads: [] as string[] };
const GOOGLE_FIELDS = { googleRefreshTokenEnc: true, googleConnectedEmail: true, googleConnectedAt: true, googleCalendarId: true, googleInvitesCalendarId: true, googleSendInvites: true, googleSyncStage: true, googleLastSyncAt: true, googleLastSyncResult: true, googleNeedsReconnect: true } as const;

before(async () => {
  accountId = (await getDefaultAccount()).id;
  saved = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: GOOGLE_FIELDS });
  setGoogleFetch(fakeGoogle);
});

after(async () => {
  setGoogleFetch(null);
  if (saved) await prisma.account.update({ where: { id: accountId }, data: saved as never });
  await prisma.googleOauthState.deleteMany({ where: { sessionId: { startsWith: "test-session" } } });
  const b = await prisma.booking.deleteMany({ where: { id: { in: made.bookings } } });
  const l = await prisma.lead.deleteMany({ where: { id: { in: made.leads } } });
  const left = { bookings: await prisma.booking.count({ where: { customerName: { startsWith: ZZ } } }), leads: await prisma.lead.count({ where: { customerName: { startsWith: ZZ } } }), states: await prisma.googleOauthState.count({ where: { sessionId: { startsWith: "test-session" } } }) };
  const restored = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { googleRefreshTokenEnc: true, googleConnectedEmail: true } });
  console.log(`# cleanup: ${b.count} bookings, ${l.count} leads; remaining ${JSON.stringify(left)}; google settings restored (token stored: ${restored.googleRefreshTokenEnc !== null}, email: ${restored.googleConnectedEmail})`);
  assert.deepEqual(left, { bookings: 0, leads: 0, states: 0 });
  await prisma.$disconnect();
});

// ---- pure --------------------------------------------------------------------------

test("the redirect URI and scopes are the locked ones, and the auth URL asks for offline access with consent", () => {
  assert.equal(REDIRECT_URI, "https://go-parties-admin-production.up.railway.app/api/integrations/google/callback");
  assert.deepEqual(SCOPES, ["openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"]);
  const u = new URL(authUrl("n.sig", "cid"));
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(u.searchParams.get("state"), "n.sig");
});

test("the state is signed for one session and a forged or foreign one does not verify", () => {
  const s = signState("nonce1", "sess-a");
  assert.equal(verifyState(s, "sess-a"), "nonce1");
  assert.equal(verifyState(s, "sess-b"), null, "another session");
  assert.equal(verifyState(s.slice(0, -1) + "x", "sess-a"), null, "tampered");
  assert.equal(verifyState("nonce1", "sess-a"), null, "unsigned");
});

test("the refresh token round-trips through AES-256-GCM and the ciphertext is opaque", () => {
  const key = encryptionKey();
  assert.ok(key && key.length === 32);
  const enc = encryptToken("rt-secret-value", key);
  assert.ok(!enc.includes("rt-secret"));
  assert.notEqual(enc, encryptToken("rt-secret-value", key), "a fresh iv each time");
  assert.equal(decryptToken(enc, key), "rt-secret-value");
  const tampered = Buffer.from(enc, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptToken(tampered.toString("base64"), key));
});

const booking = (over: Partial<BookingForCalendar> = {}): BookingForCalendar => ({
  id: "b1", customerName: "Pat Smith", occasion: "Sweet 16", eventDate: "2026-11-21", eventTime: null, timeFrom: "2 PM", timeTo: "6 PM", address: "2 Farm Rd, Avon, CT", venueName: "The Barn",
  onsiteContactName: "Pat", onsiteContactPhone: "(860) 555-0100", phone: "(860) 555-0101", email: "pat@example.com",
  items: [{ name: "MC and DJ: Basic (4 hrs)", quantity: 1 }, { name: "Uplighting", quantity: 12 }], crew: [{ name: "Jordan Crew", role: "DJ/MC" }], ...over,
});
const company = { name: "Go Event Group", phone: "413.391.4635", email: "info@thegoeventgroup.com", portalUrl: "https://store.test/party", adminUrl: "https://api.test" };

test("event times: contract from/to, else parsed booking text, else all day, in America/New_York", () => {
  const timed = eventTimes(booking());
  assert.deepEqual(timed, { start: { dateTime: "2026-11-21T19:00:00.000Z", timeZone: "America/New_York" }, end: { dateTime: "2026-11-21T23:00:00.000Z", timeZone: "America/New_York" }, allDay: false });
  const parsed = eventTimes(booking({ timeFrom: null, timeTo: null, eventTime: "noon to 4" }));
  assert.equal((parsed.start as { dateTime: string }).dateTime, "2026-11-21T17:00:00.000Z");
  assert.equal((parsed.end as { dateTime: string }).dateTime, "2026-11-21T21:00:00.000Z");
  const startOnly = eventTimes(booking({ timeFrom: "7 PM", timeTo: null, eventTime: null }));
  assert.equal((startOnly.end as { dateTime: string }).dateTime, "2026-11-22T04:00:00.000Z", "four hours when no end");
  const crossing = eventTimes(booking({ timeFrom: "9 PM", timeTo: "1 AM" }));
  assert.equal((crossing.end as { dateTime: string }).dateTime, "2026-11-22T06:00:00.000Z", "an end before the start is the next morning");
  const allDay = eventTimes(booking({ timeFrom: null, timeTo: null, eventTime: "afternoon-ish" }));
  assert.deepEqual(allDay, { start: { date: "2026-11-21" }, end: { date: "2026-11-22" }, allDay: true });
  // Summer: the offset follows the zone.
  assert.equal((eventTimes(booking({ eventDate: "2026-07-04" })).start as { dateTime: string }).dateTime, "2026-07-04T18:00:00.000Z");
});

test("GO's internal event: last name and type, venue, crew, contacts, admin link, no attendees", () => {
  const p = internalEventPayload(booking(), company);
  assert.equal(p.summary, "Smith - Sweet 16");
  assert.equal(p.location, "The Barn, 2 Farm Rd, Avon, CT");
  assert.match(p.description, /Items: MC and DJ: Basic \(4 hrs\), Uplighting x12/);
  assert.match(p.description, /Crew: Jordan Crew \(DJ\/MC\)/);
  assert.match(p.description, /On-site contact: Pat \(860\) 555-0100/);
  assert.match(p.description, /Customer: Pat Smith \(860\) 555-0101/);
  assert.match(p.description, /Admin: https:\/\/api\.test\/scheduling\/bookings\?booking=b1/);
  assert.equal(p.attendees, undefined);
  assert.equal(p.visibility, "private");
  assert.equal(internalEventPayload(booking({ customerName: "Cher" }), company).summary, "Cher - Sweet 16");
  assert.equal(internalEventPayload(booking({ occasion: null }), company).summary, "Smith - Event");
});

test("the customer invite carries customer-safe content only, the customer as the only guest", () => {
  const p = inviteEventPayload(booking(), company);
  assert.ok(p);
  assert.equal(p.summary, "Sweet 16 with Go Event Group");
  assert.deepEqual(p.attendees, [{ email: "pat@example.com" }]);
  assert.deepEqual([p.guestsCanInviteOthers, p.guestsCanSeeOtherGuests, p.guestsCanModify], [false, false, false]);
  assert.match(p.description, /Booked: MC and DJ: Basic \(4 hrs\), Uplighting x12/);
  assert.match(p.description, /Call or text 413\.391\.4635, or email info@thegoeventgroup\.com/);
  assert.match(p.description, /https:\/\/store\.test\/party/);
  const text = JSON.stringify(p);
  for (const secret of ["Jordan", "DJ/MC", "555-0100", "555-0101", "Admin", "api.test", "scheduling", "On-site"]) assert.ok(!text.includes(secret), `${secret} leaked into the invite`);
  assert.equal(inviteEventPayload(booking({ email: null }), company), null, "no email, no invite");
  assert.notEqual(syncHash(internalEventPayload(booking(), company), p), syncHash(internalEventPayload(booking({ venueName: "Elsewhere" }), company), p));
});

test("which stage puts a booking on the calendar", () => {
  assert.equal(reachesStage({ status: "Signed", retainerPaid: true }, "Confirmed"), true);
  assert.equal(reachesStage({ status: "Signed", retainerPaid: false }, "Confirmed"), false);
  assert.equal(reachesStage({ status: "Signed", retainerPaid: false }, "Signed"), true);
  assert.equal(reachesStage({ status: "Held", retainerPaid: true }, "Signed"), false);
  assert.equal(reachesStage({ status: "Completed", retainerPaid: true }, "Confirmed"), true);
  assert.equal(reachesStage({ status: "Cancelled", retainerPaid: true }, "Signed"), false);
  assert.equal(reachesStage({ status: "Released", retainerPaid: false }, "Signed"), false);
});

// ---- with the database -----------------------------------------------------------------

async function makeBooking(n: number, over: { status?: string; retainerPaid?: boolean; email?: string | null; days?: number } = {}) {
  const policy =
    (await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } })) ??
    (await prisma.policyVersion.create({ data: { accountId, version: 1, text: `${ZZ} policy` } }));
  // Production has a "New" lead status; a throwaway database may not.
  const status = (await prisma.leadStatus.findFirst({ where: { accountId }, orderBy: { position: "asc" } })) ?? (await prisma.leadStatus.create({ data: { accountId, name: "New", position: 0 } }));
  const lead = await prisma.lead.create({ data: { accountId, status: status.name, source: "manual", customerName: `${ZZ} lead` } });
  made.leads.push(lead.id);
  let id = "";
  await prisma.$transaction(async (tx) => {
    const b = await tx.booking.create({
      data: { accountId, leadId: lead.id, eventDate: new Date(`${addDays(new Date().toISOString().slice(0, 10), over.days ?? 30 + n)}T00:00:00Z`), customerName: `${ZZ} Cal Client${n}`, phone: `+1500555040${n}`, email: over.email === undefined ? `zz${n}@example.invalid` : over.email, status: over.status ?? "Signed", retainerPaid: over.retainerPaid ?? true, occasion: "Graduation", timeFrom: "1 PM", timeTo: "5 PM", venueName: "ZZTEST Hall", address: "1 Hall St" },
    });
    await tx.agreement.create({ data: { accountId, bookingId: b.id, policyVersionId: policy.id, checkboxChecked: true } });
    id = b.id;
  });
  made.bookings.push(id);
  return id;
}
const row = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id }, select: { googleEventId: true, googleInviteEventId: true, googleSyncError: true, googleSyncHash: true } });

test("the OAuth round trip: a state is spent once; connecting stores the token encrypted and who connected", async () => {
  const { state } = await beginConnect("test-session-1");
  assert.equal(await spendState(state, "test-session-2"), false, "another session cannot spend it");
  assert.equal(await spendState(state, "test-session-1"), true);
  assert.equal(await spendState(state, "test-session-1"), false, "replay is refused");
  const { state: old } = await beginConnect("test-session-3");
  assert.equal(await spendState(old, "test-session-3", new Date(Date.now() + 11 * 60_000)), false, "an old state has expired");
  await prisma.account.update({ where: { id: accountId }, data: { googleCalendarId: null, googleRefreshTokenEnc: null, googleNeedsReconnect: true } });
  const { email } = await finishConnect("the-code");
  assert.equal(email, "info@thegoeventgroup.com");
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: GOOGLE_FIELDS });
  assert.ok(a.googleRefreshTokenEnc && !a.googleRefreshTokenEnc.includes("rt-secret"));
  assert.equal(decryptToken(a.googleRefreshTokenEnc, encryptionKey()!), "rt-secret-value");
  assert.equal(a.googleConnectedEmail, "info@thegoeventgroup.com");
  assert.equal(a.googleCalendarId, "primary-cal", "the primary calendar is picked");
  assert.equal(a.googleNeedsReconnect, false);
  assert.ok(!JSON.stringify(calls.map((c) => c.url)).includes("rt-secret"), "no token in any URL");
});

test("create, update, unchanged, delete, and never a duplicate; invites off creates no customer event", async () => {
  await prisma.account.update({ where: { id: accountId }, data: { googleInvitesCalendarId: "invites-cal", googleSendInvites: false, googleSyncStage: "Confirmed" } });
  const id = await makeBooking(1);
  calls.length = 0;
  assert.equal((await syncBooking(id)).action, "created");
  const first = await row(id);
  assert.ok(first.googleEventId && events.has(first.googleEventId));
  assert.equal(first.googleInviteEventId, null, "invites are off");
  assert.equal(events.get(first.googleEventId)!.calendar, "primary-cal");
  assert.equal(events.get(first.googleEventId)!.payload.attendees, undefined);
  // Again: nothing changed, nothing sent, same event.
  calls.length = 0;
  assert.equal((await syncBooking(id)).action, "unchanged");
  assert.equal(calls.filter((c) => c.method !== "POST" || !c.url.includes("token")).length, 0);
  assert.equal((await row(id)).googleEventId, first.googleEventId);
  // A change updates in place.
  await prisma.booking.update({ where: { id }, data: { venueName: "ZZTEST Other Hall" } });
  assert.equal((await syncBooking(id)).action, "updated");
  assert.equal((await row(id)).googleEventId, first.googleEventId);
  assert.equal(events.get(first.googleEventId)!.payload.location, "ZZTEST Other Hall, 1 Hall St");
  assert.equal(events.size, 1, "never a second event");
  // Dropping below the stage deletes.
  await prisma.booking.update({ where: { id }, data: { retainerPaid: false } });
  assert.equal((await syncBooking(id)).action, "deleted");
  assert.equal(events.size, 0);
  assert.deepEqual(await row(id), { googleEventId: null, googleInviteEventId: null, googleSyncError: null, googleSyncHash: null });
});

test("with invites on, the customer event goes to the invites calendar with sendUpdates=all, and is cancelled with the booking", async () => {
  await prisma.account.update({ where: { id: accountId }, data: { googleInvitesCalendarId: "invites-cal", googleSendInvites: true, googleSyncStage: "Signed" } });
  const id = await makeBooking(2, { retainerPaid: false });
  calls.length = 0;
  assert.equal((await syncBooking(id)).action, "created");
  const r = await row(id);
  assert.ok(r.googleEventId && r.googleInviteEventId);
  const invite = events.get(r.googleInviteEventId)!;
  assert.equal(invite.calendar, "invites-cal");
  assert.deepEqual(invite.payload.attendees, [{ email: "zz2@example.invalid" }]);
  const insertInvite = calls.find((c) => c.method === "POST" && c.url.includes("invites-cal"))!;
  assert.match(insertInvite.url, /sendUpdates=all/);
  const insertInternal = calls.find((c) => c.method === "POST" && c.url.includes("primary-cal"))!;
  assert.match(insertInternal.url, /sendUpdates=none/);
  assert.ok(!JSON.stringify(invite.payload).includes("Admin"));
  // A booking with no email gets GO's event only.
  const noEmail = await makeBooking(3, { retainerPaid: false, email: null });
  await syncBooking(noEmail);
  assert.equal((await row(noEmail)).googleInviteEventId, null);
  // Cancelled: both go, the invite with sendUpdates=all so the customer hears.
  calls.length = 0;
  await prisma.booking.update({ where: { id }, data: { status: "Cancelled" } });
  assert.equal((await syncBooking(id)).action, "deleted");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.includes("invites-cal") && c.url.includes("sendUpdates=all")));
  assert.equal(events.has(r.googleInviteEventId), false);
});

test("reconcile repairs an event removed on Google's side and skips what is unchanged", async () => {
  await prisma.account.update({ where: { id: accountId }, data: { googleSendInvites: false, googleSyncStage: "Signed" } });
  const id = await makeBooking(4, { retainerPaid: false, days: 10 });
  await syncBooking(id);
  const before = (await row(id)).googleEventId!;
  events.delete(before); // someone deleted it in Google
  const r = await reconcileCalendar();
  assert.equal(r.connected, true);
  assert.ok(r.checked >= 1);
  const after = (await row(id)).googleEventId!;
  assert.notEqual(after, before);
  assert.ok(events.has(after));
  const again = await reconcileCalendar();
  assert.ok(again.unchanged >= 1 && again.failed === 0);
  const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { googleLastSyncAt: true, googleLastSyncResult: true } });
  assert.ok(a.googleLastSyncAt);
});

test("a revoked token flags the connection for reconnect and nothing else breaks", async () => {
  const id = await makeBooking(5, { retainerPaid: false });
  refreshFails = "invalid_grant";
  try {
    const o = await syncBooking(id);
    assert.equal(o.action, "failed");
    assert.match(o.detail ?? "", /invalid_grant/);
    const a = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { googleNeedsReconnect: true } });
    assert.equal(a.googleNeedsReconnect, true);
    assert.match((await row(id)).googleSyncError ?? "", /invalid_grant/);
    assert.equal((await syncBooking(id)).action, "skipped", "nothing is tried while a reconnect is needed");
    const rec = await reconcileCalendar();
    assert.deepEqual([rec.connected, rec.needsReconnect], [false, true]);
  } finally {
    refreshFails = "no";
    await prisma.account.update({ where: { id: accountId }, data: { googleNeedsReconnect: false } });
  }
});

test("a Google outage is written on the booking and retried later; the booking change itself is unaffected", async () => {
  const id = await makeBooking(6, { retainerPaid: false });
  failInserts = true;
  try {
    const o = await syncBooking(id);
    assert.equal(o.action, "failed");
    const r = await row(id);
    assert.equal(r.googleEventId, null);
    assert.match(r.googleSyncError ?? "", /503/);
  } finally {
    failInserts = false;
  }
  assert.equal((await syncBooking(id)).action, "created", "the next pass succeeds");
  assert.equal((await row(id)).googleSyncError, null);
  // GoogleError never carries a token.
  const e = new GoogleError(401, "unauthorized", "Google answered 401");
  assert.equal(e.revoked, true);
});
