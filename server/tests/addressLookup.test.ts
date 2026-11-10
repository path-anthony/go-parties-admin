// Block A9, on a throwaway database with Google mocked: the exact address
// at the hold, the quote and the customer's home address; the fallbacks
// when Google cannot answer; the cache and the daily cap; and the Maps
// link on the calendar payload, the crew page, the email token and the
// customer booking. Every row made here is deleted at the end with counts.
process.env.COOKIE_SECRET = "zz-test-cookie-secret-that-is-long-enough-32";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_PHONE_NUMBER = "+15005550006";
process.env.STOREFRONT_URL = "https://store.test";
process.env.PUBLIC_API_URL = "https://api.test";
process.env.NODE_ENV = "test";
process.env.ALLOWED_ORIGINS = "https://store.test";
process.env.GOOGLE_MAPS_SERVER_KEY = "zz-maps-key";
delete process.env.EMAIL_WEBHOOK_URL;
delete process.env.STRIPE_SECRET_KEY;

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { getDefaultAccount } from "../account.js";
import { CACHE_DAYS, MAPS_DAILY_CAP, checkBookingAddress, geocodeCandidate, judgeCandidate, lookupAddress, mapsStatus, placeCandidate } from "../addressLookup.js";
import { addDays } from "../automation/time.js";
import { serializeBid } from "../bids.js";
import { prisma } from "../db.js";
import { bookingMapsUrl, setMapsFetch } from "../delivery.js";
import { internalEventPayload, inviteEventPayload } from "../google/payload.js";
import { composeValues } from "../messageContext.js";
import { customerWriteGuard } from "../security.js";
import { getSettings } from "../settings.js";
import customerRouter from "../routes/customer.js";
import directBookingsRouter from "../routes/directBookings.js";
import tierRouter from "../routes/tier.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("addressLookup.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
let accountId = "";
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const made = { items: [] as string[], customers: [] as string[], bookings: [] as string[], policies: [] as string[], statuses: [] as string[] };
let small = "";

// ---- Google, mocked ----------------------------------------------------------------
const US = { long_name: "United States", short_name: "US", types: ["country", "political"] };
const geo = (over: Record<string, unknown> = {}) => ({
  place_id: "geo-office",
  formatted_address: "767 New Britain Ave, Farmington, CT 06032, USA",
  types: ["street_address"],
  geometry: { location: { lat: 41.7198, lng: -72.8321 }, location_type: "ROOFTOP" },
  address_components: [
    { long_name: "767", short_name: "767", types: ["street_number"] },
    { long_name: "New Britain Avenue", short_name: "New Britain Ave", types: ["route"] },
    { long_name: "Farmington", short_name: "Farmington", types: ["locality", "political"] },
    { long_name: "Connecticut", short_name: "CT", types: ["administrative_area_level_1", "political"] },
    { long_name: "06032", short_name: "06032", types: ["postal_code"] },
    US,
  ],
  ...over,
});
const geocodes: Record<string, unknown> = {
  "767 new britain ave, farmington, ct": { status: "OK", results: [geo()] },
  "farmington, ct": { status: "OK", results: [geo({ place_id: "geo-town", formatted_address: "Farmington, CT, USA", types: ["locality", "political"], address_components: [{ long_name: "Farmington", short_name: "Farmington", types: ["locality"] }, US] })] },
  "new britain ave, farmington, ct": { status: "OK", results: [geo({ place_id: "geo-route", formatted_address: "New Britain Ave, Farmington, CT, USA", types: ["route"], geometry: { location: { lat: 41.72, lng: -72.83 }, location_type: "GEOMETRIC_CENTER" }, address_components: [{ long_name: "New Britain Avenue", short_name: "New Britain Ave", types: ["route"] }, US] })] },
  "10 downing st, london": { status: "OK", results: [geo({ place_id: "geo-uk", formatted_address: "10 Downing St, London SW1A 2AA, UK", address_components: [{ long_name: "10", short_name: "10", types: ["street_number"] }, { long_name: "Downing Street", short_name: "Downing St", types: ["route"] }, { long_name: "United Kingdom", short_name: "GB", types: ["country", "political"] }] })] },
  "nowhere at all": { status: "ZERO_RESULTS", results: [] },
  "12 home st, avon, ct": { status: "OK", results: [geo({ place_id: "geo-home", formatted_address: "12 Home St, Avon, CT 06001, USA", address_components: [{ long_name: "12", short_name: "12", types: ["street_number"] }, { long_name: "Home Street", short_name: "Home St", types: ["route"] }, { long_name: "Avon", short_name: "Avon", types: ["locality"] }, { long_name: "Connecticut", short_name: "CT", types: ["administrative_area_level_1"] }, { long_name: "06001", short_name: "06001", types: ["postal_code"] }, US], geometry: { location: { lat: 41.81, lng: -72.83 }, location_type: "RANGE_INTERPOLATED" } })] },
};
const places: Record<string, unknown> = {
  "place-ok": { id: "place-ok", formattedAddress: "14 Maple Ln, Avon, CT 06001, USA", types: ["street_address"], location: { latitude: 41.8102, longitude: -72.8309 }, addressComponents: [{ types: ["street_number"], longText: "14", shortText: "14" }, { types: ["route"], longText: "Maple Lane", shortText: "Maple Ln" }, { types: ["locality"], longText: "Avon", shortText: "Avon" }, { types: ["administrative_area_level_1"], longText: "Connecticut", shortText: "CT" }, { types: ["postal_code"], longText: "06001", shortText: "06001" }, { types: ["country"], longText: "United States", shortText: "US" }] },
  "place-city": { id: "place-city", formattedAddress: "Avon, CT, USA", types: ["locality"], location: { latitude: 41.8102, longitude: -72.8309 }, addressComponents: [{ types: ["locality"], longText: "Avon", shortText: "Avon" }, { types: ["country"], longText: "United States", shortText: "US" }] },
};
let googleCalls = 0;
let googleDown = false;
setMapsFetch((url) => {
  googleCalls += 1;
  if (googleDown) return Promise.resolve(new Response("boom", { status: 500 }));
  const u = new URL(url);
  if (u.hostname === "places.googleapis.com") {
    const id = decodeURIComponent(u.pathname.split("/v1/places/")[1] ?? "");
    const p = places[id];
    return Promise.resolve(new Response(JSON.stringify(p ?? { error: { code: 404 } }), { status: p ? 200 : 404 }));
  }
  const q = (u.searchParams.get("address") ?? "").toLowerCase();
  const g = geocodes[q] ?? { status: "ZERO_RESULTS", results: [] };
  return Promise.resolve(new Response(JSON.stringify(g), { status: 200 }));
});

// ---- helpers ----------------------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.twilio.com/")) return Promise.resolve(new Response(JSON.stringify({ sid: "SMzz" }), { status: 201 }));
  return realFetch(input, init);
}) as typeof fetch;
type Res = { status: number; json: Record<string, unknown>; cookie: string | null };
let ipCount = 0;
async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res> {
  ipCount += 1;
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://store.test", "X-Forwarded-For": `10.9.${Math.floor(ipCount / 200)}.${ipCount % 200}` };
  if (init.cookie) headers.Cookie = init.cookie;
  const r = await realFetch(`${base}${path}`, { ...init, headers });
  const set = r.headers.get("set-cookie");
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown>, cookie: set ? set.split(";")[0] : null };
}
const post = (path: string, body: unknown, cookie?: string) => call(path, { method: "POST", body: JSON.stringify(body), cookie });
const patch = (path: string, body: unknown, cookie?: string) => call(path, { method: "PATCH", body: JSON.stringify(body), cookie });
const get = (path: string, cookie?: string) => call(path, { cookie });
const day = (n: number) => addDays(new Date().toISOString().slice(0, 10), n);
let holdCount = 0;
function holdBody(over: Record<string, unknown> = {}) {
  holdCount += 1;
  return { itemId: small, eventDate: day(60 + holdCount), eventTime: "2 PM", customerName: `${ZZ} Customer ${holdCount}`, phone: `+150055503${String(holdCount).padStart(2, "0")}`, email: `zz-a9-${holdCount}@example.test`, agreedToPolicy: true, delivery: null, ...over };
}
const track = (r: Res) => {
  if (typeof r.json.bookingId === "string") made.bookings.push(r.json.bookingId);
  return r;
};
let signupCount = 0;
async function signUp(over: Record<string, unknown> = {}) {
  signupCount += 1;
  const r = await post("/api/customer/signup", { name: `${ZZ} Holder ${signupCount}`, phone: `+150055508${String(signupCount).padStart(2, "0")}`, email: `zz-a9-holder-${signupCount}@example.test`, password: "a-long-enough-password", ...over });
  if (r.status === 201) made.customers.push((r.json.customer as { id: string }).id);
  return r;
}
const delivery = (placeId: string) => ({ placeId, formattedAddress: "14 Maple Ln, Avon, CT 06001, USA", components: { streetNumber: "14", route: "Maple Lane", city: "Avon", state: "CT", zip: "06001" }, addressLat: 41.8102, addressLng: -72.8309, setupLat: 41.8103, setupLng: -72.8308, setupNotes: "Backyard, gate on the left" });

before(async () => {
  accountId = (await getDefaultAccount()).id;
  // Rows a run that was cut short may have left behind.
  await prisma.customer.deleteMany({ where: { accountId, email: { startsWith: "zz-a9-" } } });
  await prisma.addressLookup.deleteMany({});
  await prisma.usageCounter.deleteMany({ where: { key: "maps_lookup" } });
  const item = await prisma.item.create({ data: { accountId, name: `${ZZ} A9 Bounce House`, category: "Inflatables", price: 200, units: { create: [{ label: "A9-1" }, { label: "A9-2" }, { label: "A9-3" }, { label: "A9-4" }, { label: "A9-5" }, { label: "A9-6" }] } } });
  made.items.push(item.id);
  small = item.id;
  if ((await prisma.leadStatus.count({ where: { accountId } })) === 0) made.statuses.push((await prisma.leadStatus.create({ data: { accountId, name: "New", position: 0 } })).id);
  const policy = await prisma.policyVersion.findFirst({ where: { accountId }, orderBy: { version: "desc" } });
  if (!policy || policy.text.trim() === "") made.policies.push((await prisma.policyVersion.create({ data: { accountId, version: (policy?.version ?? 0) + 1, text: `${ZZ} rental policy: the retainer is {{depositPercentage}}% and non-refundable.` } })).id);
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use("/api/customer", customerWriteGuard);
  app.use("/api/bookings/direct", customerWriteGuard);
  app.use("/api/bookings/tier", customerWriteGuard);
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/customer", customerRouter);
  app.use("/api/bookings/direct", directBookingsRouter);
  app.use("/api/bookings/tier", tierRouter);
  app.use(((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.log("[test] route threw:", err instanceof Error ? err.stack : String(err));
    res.status(500).json({ error: "test: route threw" });
  }) as express.ErrorRequestHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  const counts = {
    bookings: (await prisma.booking.deleteMany({ where: { id: { in: made.bookings } } })).count,
    leads: (await prisma.lead.deleteMany({ where: { accountId, customerName: { startsWith: ZZ } } })).count,
    customers: (await prisma.customer.deleteMany({ where: { id: { in: made.customers } } })).count,
    items: (await prisma.item.deleteMany({ where: { id: { in: made.items } } })).count,
    lookups: (await prisma.addressLookup.deleteMany({})).count,
    notifications: (await prisma.notification.deleteMany({ where: { accountId, type: { in: ["address-checks-paused", "address-not-checked"] } } })).count,
    counters: (await prisma.usageCounter.deleteMany({ where: { key: "maps_lookup" } })).count,
    policies: (await prisma.policyVersion.deleteMany({ where: { id: { in: made.policies } } })).count,
    statuses: (await prisma.leadStatus.deleteMany({ where: { id: { in: made.statuses } } })).count,
  };
  await prisma.account.update({ where: { id: accountId }, data: { mapsLastError: null, mapsLastErrorAt: null } });
  console.log("cleanup", JSON.stringify(counts));
  await prisma.$disconnect();
});

// ---- pure -----------------------------------------------------------------------------
test("judgeCandidate: a rooftop street address in the US is exact; a town, a street, a rough point and another country are not", () => {
  const ok = judgeCandidate(geocodeCandidate(geo()));
  assert.ok("place" in ok);
  assert.deepEqual(ok.place.components, { streetNumber: "767", route: "New Britain Avenue", city: "Farmington", state: "CT", zip: "06032" });
  assert.equal(ok.place.placeId, "geo-office");
  const town = judgeCandidate(geocodeCandidate((geocodes["farmington, ct"] as { results: Parameters<typeof geocodeCandidate>[0][] }).results[0]));
  assert.ok("reason" in town && /street number/.test(town.reason));
  const route = judgeCandidate(geocodeCandidate((geocodes["new britain ave, farmington, ct"] as { results: Parameters<typeof geocodeCandidate>[0][] }).results[0]));
  assert.ok("reason" in route);
  const rough = judgeCandidate(geocodeCandidate(geo({ geometry: { location: { lat: 1, lng: 1 }, location_type: "APPROXIMATE" } })));
  assert.ok("reason" in rough && /roughly/.test(rough.reason));
  const uk = judgeCandidate(geocodeCandidate((geocodes["10 downing st, london"] as { results: Parameters<typeof geocodeCandidate>[0][] }).results[0]));
  assert.ok("reason" in uk && /outside the United States/.test(uk.reason));
  const place = judgeCandidate(placeCandidate(places["place-ok"] as Parameters<typeof placeCandidate>[0]));
  assert.ok("place" in place && place.place.components.zip === "06001");
  const city = judgeCandidate(placeCandidate(places["place-city"] as Parameters<typeof placeCandidate>[0]));
  assert.ok("reason" in city);
});

test("bookingMapsUrl: the exact place, else the setup pin, else the address point, else nothing", () => {
  assert.equal(bookingMapsUrl({ placeId: "p1", addressLat: 41.7198, addressLng: -72.8321, setupLat: 1, setupLng: 1 }), "https://www.google.com/maps/search/?api=1&query=41.719800,-72.832100&query_place_id=p1");
  assert.equal(bookingMapsUrl({ placeId: null, addressLat: 41.7198, addressLng: -72.8321, setupLat: 41.72, setupLng: -72.83 }), "https://www.google.com/maps/search/?api=1&query=41.720000,-72.830000");
  assert.equal(bookingMapsUrl({ placeId: null, addressLat: 41.7198, addressLng: -72.8321, setupLat: null, setupLng: null }), "https://www.google.com/maps/search/?api=1&query=41.719800,-72.832100");
  assert.equal(bookingMapsUrl({ placeId: null, addressLat: null, addressLng: null }), null);
});

test("calendar payloads, the crew page and the email token carry the exact place link", () => {
  const b = { id: "b1", customerName: "Sarah Miller", occasion: "Sweet 16", eventDate: day(30), eventTime: "2 PM", timeFrom: null, timeTo: null, address: "767 New Britain Ave, Farmington, CT 06032, USA", venueName: null, onsiteContactName: null, onsiteContactPhone: null, phone: "+18605550100", email: "sarah@example.test", items: [], crew: [], setupLat: null, setupLng: null, setupNotes: null, addressCheck: "verified", placeId: "geo-office", addressLat: 41.7198, addressLng: -72.8321 };
  const company = { name: "GO", phone: "(860) 555-0100", email: "go@example.test", portalUrl: "https://store.test/party", adminUrl: "https://admin.test" };
  const link = "https://www.google.com/maps/search/?api=1&query=41.719800,-72.832100&query_place_id=geo-office";
  assert.ok(internalEventPayload(b, company).description.includes(`Map: ${link} (address verified)`));
  assert.equal(internalEventPayload(b, company).location, b.address);
  const invite = inviteEventPayload(b, company);
  assert.ok(invite && invite.description.includes(`Map: ${link}`));
  assert.ok(invite && !invite.description.includes("admin.test"));
  const offer = { id: "o", gigId: "g", crewMemberId: "c", token: "t", status: "Accepted", bidAmount: 300, bidNote: null, bidSubmittedAt: new Date(), deadlineAt: new Date(Date.now() + 86_400_000), confirmedAt: null, createdAt: new Date(), updatedAt: new Date(), crewMember: { name: "Alex Doe" }, questions: [], gig: { id: "g", skill: "DJ", eventType: "Sweet 16", guestCount: 40, eventDate: new Date(), startTime: "2 PM", endTime: "6 PM", town: "Farmington", payMin: 200, payMax: 400, status: "filled", arrivalNotes: null, filledById: "c", booking: { address: b.address, eventTime: "2 PM", setupLat: null, setupLng: null, placeId: "geo-office", addressLat: 41.7198, addressLng: -72.8321 } } };
  const page = serializeBid(offer as unknown as Parameters<typeof serializeBid>[0], new Date(), "+18605550100");
  assert.equal(page.state, "accepted");
  assert.equal(page.mapsUrl, link);
});

test("eventMapLink token: the place, else a search by the typed address, else a note (never empty)", async () => {
  const settings = await getSettings(accountId);
  const booking = { id: "b1", customerName: "Sarah Miller", eventDate: new Date(), eventTime: null, occasion: null, address: "767 New Britain Ave, Farmington, CT 06032, USA", total: null, placeId: "geo-office", addressLat: 41.7198, addressLng: -72.8321 };
  assert.equal(composeValues(settings, { booking }).event_map_link, "https://www.google.com/maps/search/?api=1&query=41.719800,-72.832100&query_place_id=geo-office");
  assert.equal(composeValues(settings, { booking: { ...booking, placeId: null, addressLat: null, addressLng: null } }).event_map_link, "https://www.google.com/maps/search/?api=1&query=767%20New%20Britain%20Ave%2C%20Farmington%2C%20CT%2006032%2C%20USA");
  assert.equal(composeValues(settings, { booking: { ...booking, placeId: null, addressLat: null, addressLng: null, address: null } }).event_map_link, "address to be confirmed");
});

// ---- the hold --------------------------------------------------------------------------
test("hold: a typed exact address is stored as Google writes it, verified, with the place link", async () => {
  googleCalls = 0;
  const r = track(await post("/api/bookings/direct", holdBody({ address: "767 New Britain Ave, Farmington, CT" })));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.address, "767 New Britain Ave, Farmington, CT 06032, USA");
  assert.equal(r.json.mapsUrl, "https://www.google.com/maps/search/?api=1&query=41.719800,-72.832100&query_place_id=geo-office");
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: r.json.bookingId as string } });
  assert.equal(b.addressCheck, "verified");
  assert.equal(b.placeId, "geo-office");
  assert.equal(b.addressLat, 41.7198);
  assert.deepEqual(b.deliveryComponents, { streetNumber: "767", route: "New Britain Avenue", city: "Farmington", state: "CT", zip: "06032" });
  assert.equal(b.mailingAddress, "767 New Britain Avenue");
  assert.equal(b.zip, "06032");
  assert.ok(b.addressCheckedAt);
  assert.equal(googleCalls, 1);
});

test("hold: the place id path uses Place Details and keeps the storefront's setup pin", async () => {
  const r = track(await post("/api/bookings/direct", holdBody({ delivery: delivery("place-ok"), address: "14 maple lane avon" })));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.address, "14 Maple Ln, Avon, CT 06001, USA");
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: r.json.bookingId as string } });
  assert.equal(b.placeId, "place-ok");
  assert.equal(b.addressCheck, "verified");
  assert.equal(b.setupLat, 41.8103);
  assert.equal(b.setupNotes, "Backyard, gate on the left");
  const portal = await get(`/api/customer/bookings`);
  assert.equal(portal.status, 401, "sanity: the customer routes still need a session");
});

test("hold: a town, a street with no number, and an address outside the US are refused with address-not-exact", async () => {
  for (const address of ["Farmington, CT", "New Britain Ave, Farmington, CT", "10 Downing St, London", "nowhere at all"]) {
    const r = await post("/api/bookings/direct", holdBody({ address }));
    assert.equal(r.status, 400, address);
    assert.equal(r.json.reason, "address-not-exact", address);
    assert.equal(r.json.field, "address");
    assert.equal(r.json.error, "We couldn't find that exact address. Pick it from the suggestions, or check the street number.");
  }
  const city = await post("/api/bookings/direct", holdBody({ delivery: delivery("place-city") }));
  assert.equal(city.status, 400);
  assert.equal(city.json.reason, "address-not-exact");
  const none = await prisma.booking.count({ where: { accountId, customerName: { startsWith: `${ZZ} Customer` }, address: { in: ["Farmington, CT", "nowhere at all"] } } });
  assert.equal(none, 0, "nothing was held");
});

test("quote (tier call): the same lookup refuses an inexact address and returns the exact one", async () => {
  const bad = await post("/api/bookings/tier", { itemId: small, eventDate: day(90), address: "Farmington, CT" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.reason, "address-not-exact");
  const ok = await post("/api/bookings/tier", { itemId: small, eventDate: day(90), address: "767 New Britain Ave, Farmington, CT" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.address, { formattedAddress: "767 New Britain Ave, Farmington, CT 06032, USA", placeId: "geo-office", lat: 41.7198, lng: -72.8321 });
  const byId = await post("/api/bookings/tier", { itemId: small, eventDate: day(90), placeId: "place-ok" });
  assert.equal((byId.json.address as { placeId: string }).placeId, "place-ok");
  const noneSent = await post("/api/bookings/tier", { itemId: small, eventDate: day(90) });
  assert.equal(noneSent.json.address, null);
});

test("cache: the same text or place id again makes no Google call", async () => {
  googleCalls = 0;
  const a = await lookupAddress(accountId, { text: "767 New Britain Ave., Farmington, CT" });
  assert.equal(a.kind, "exact");
  assert.equal(a.kind === "exact" && a.cached, true, "punctuation and case do not matter");
  const p = await lookupAddress(accountId, { placeId: "place-ok" });
  assert.equal(p.kind === "exact" && p.cached, true);
  const no = await lookupAddress(accountId, { text: "FARMINGTON, CT" });
  assert.equal(no.kind, "not-exact");
  assert.equal(no.kind === "not-exact" && no.cached, true, "a clear no is kept too");
  assert.equal(googleCalls, 0);
  const row = await prisma.addressLookup.findUniqueOrThrow({ where: { key: "text:767 new britain ave farmington ct" } });
  assert.ok(row.expiresAt.getTime() - Date.now() > (CACHE_DAYS - 1) * 86_400_000);
  // A fresh text costs one call; a Google error is not kept.
  googleDown = true;
  const down = await lookupAddress(accountId, { text: "1 Fresh Way, Avon, CT" });
  googleDown = false;
  assert.equal(down.kind, "unavailable");
  assert.equal(await prisma.addressLookup.count({ where: { key: "text:1 fresh way avon ct" } }), 0);
  assert.match((await mapsStatus(accountId)).lastError ?? "", /500/);
});

test("fallbacks: no key or Google down never block a hold; the address is saved as typed and marked not checked", async () => {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  delete process.env.GOOGLE_MAPS_SERVER_KEY;
  const nokey = track(await post("/api/bookings/direct", holdBody({ address: "2 Unknown Rd, Avon, CT" })));
  process.env.GOOGLE_MAPS_SERVER_KEY = key;
  assert.equal(nokey.status, 201, JSON.stringify(nokey.json));
  assert.equal(nokey.json.mapsUrl, null);
  let b = await prisma.booking.findUniqueOrThrow({ where: { id: nokey.json.bookingId as string } });
  assert.equal(b.address, "2 Unknown Rd, Avon, CT");
  assert.equal(b.addressCheck, "not_checked");
  assert.match(b.addressCheckReason ?? "", /no Google Maps key/);
  googleDown = true;
  const down = track(await post("/api/bookings/direct", holdBody({ address: "3 Unknown Rd, Avon, CT" })));
  googleDown = false;
  assert.equal(down.status, 201, JSON.stringify(down.json));
  b = await prisma.booking.findUniqueOrThrow({ where: { id: down.json.bookingId as string } });
  assert.equal(b.addressCheck, "not_checked");
  assert.match(b.addressCheckReason ?? "", /could not be reached/);
  const status = await mapsStatus(accountId);
  assert.ok(status.lastError && status.lastErrorAt);
});

test("daily cap: past the limit nothing is called, holds fall back, and staff are told once", async () => {
  const dayKey = (await prisma.usageCounter.findFirst({ where: { accountId, key: "maps_lookup" } }))!.day;
  await prisma.usageCounter.update({ where: { accountId_key_day: { accountId, key: "maps_lookup", day: dayKey } }, data: { count: MAPS_DAILY_CAP } });
  googleCalls = 0;
  const r = track(await post("/api/bookings/direct", holdBody({ address: "4 Capped Rd, Avon, CT" })));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: r.json.bookingId as string } });
  assert.equal(b.addressCheck, "not_checked");
  assert.match(b.addressCheckReason ?? "", /paused for today/);
  assert.equal(googleCalls, 0);
  await post("/api/bookings/direct", holdBody({ address: "5 Capped Rd, Avon, CT" })).then(track);
  const notices = await prisma.notification.findMany({ where: { accountId, type: "address-checks-paused" } });
  assert.equal(notices.length, 1, "one notice for the day");
  assert.equal(notices[0].title, "Address checks paused for today");
  // Cached answers still work with the cap reached.
  const cached = await lookupAddress(accountId, { text: "767 New Britain Ave, Farmington, CT" });
  assert.equal(cached.kind, "exact");
  assert.equal((await mapsStatus(accountId)).todayLookups, MAPS_DAILY_CAP);
  await prisma.usageCounter.update({ where: { accountId_key_day: { accountId, key: "maps_lookup", day: dayKey } }, data: { count: 5 } });
});

// ---- the home address -------------------------------------------------------------------
test("home address: checked at sign-up and on PATCH /me, stored as Google writes it, refused when inexact, kept as typed when Google is down", async () => {
  const bad = await signUp({ homeAddress: "Farmington, CT" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.reason, "address-not-exact");
  assert.equal(bad.json.field, "homeAddress");
  const r = await signUp({ homeAddress: "12 Home St, Avon, CT" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const cookie = r.cookie!;
  const me = (r.json.customer as Record<string, unknown>);
  assert.equal(me.homeAddress, "12 Home St, Avon, CT 06001, USA");
  let c = await prisma.customer.findUniqueOrThrow({ where: { id: me.id as string } });
  assert.equal(c.homePlaceId, "geo-home");
  assert.equal(c.homeLat, 41.81);
  assert.ok(c.homeCheckedAt);
  const p = await patch("/api/customer/me", { homeAddress: "New Britain Ave, Farmington, CT" }, cookie);
  assert.equal(p.status, 400);
  assert.equal(p.json.field, "homeAddress");
  const moved = await patch("/api/customer/me", { homeAddress: "767 New Britain Ave, Farmington, CT" }, cookie);
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  c = await prisma.customer.findUniqueOrThrow({ where: { id: me.id as string } });
  assert.equal(c.homeAddress, "767 New Britain Ave, Farmington, CT 06032, USA");
  assert.equal(c.homePlaceId, "geo-office");
  googleDown = true;
  const typed = await patch("/api/customer/me", { homeAddress: "6 Quiet Ln, Avon, CT" }, cookie);
  googleDown = false;
  assert.equal(typed.status, 200);
  c = await prisma.customer.findUniqueOrThrow({ where: { id: me.id as string } });
  assert.equal(c.homeAddress, "6 Quiet Ln, Avon, CT");
  assert.equal(c.homePlaceId, null);
  assert.equal(c.homeCheckedAt, null);
  const cleared = await patch("/api/customer/me", { homeAddress: "" }, cookie);
  assert.equal(cleared.status, 200);
  c = await prisma.customer.findUniqueOrThrow({ where: { id: me.id as string } });
  assert.equal(c.homeAddress, null);
  assert.equal(c.homePlaceId, null);
});

test("same-as-home: the hold copies the verified home address and its place; a home sent with the hold is checked and saved too", async () => {
  const r = await signUp({ homeAddress: "767 New Britain Ave, Farmington, CT" });
  assert.equal(r.status, 201);
  const cookie = r.cookie!;
  const hold = track(await post("/api/bookings/direct", holdBody({ address: "Farmington, CT", eventAddressSameAsHome: true }), cookie));
  assert.equal(hold.status, 201, JSON.stringify(hold.json));
  assert.equal(hold.json.address, "767 New Britain Ave, Farmington, CT 06032, USA");
  let b = await prisma.booking.findUniqueOrThrow({ where: { id: hold.json.bookingId as string } });
  assert.equal(b.placeId, "geo-office");
  assert.equal(b.addressCheck, "verified");
  assert.equal(b.eventAddressSameAsHome, true);
  // The customer booking response carries the link.
  const mine = await get("/api/customer/bookings", cookie);
  assert.equal(mine.status, 200);
  const row = (mine.json as unknown as Record<string, unknown>[]).find((x) => x.id === hold.json.bookingId)!;
  assert.equal(row.mapsUrl, "https://www.google.com/maps/search/?api=1&query=41.719800,-72.832100&query_place_id=geo-office");
  assert.equal((row.delivery as { verified: boolean }).verified, true);
  // A new account with no home: the hold brings one, checked and saved with its place, and the event copies it.
  const fresh = await signUp();
  const withHome = track(await post("/api/bookings/direct", holdBody({ homeAddress: "12 Home St, Avon, CT", eventAddressSameAsHome: true }), fresh.cookie!));
  assert.equal(withHome.status, 201, JSON.stringify(withHome.json));
  assert.equal(withHome.json.address, "12 Home St, Avon, CT 06001, USA");
  b = await prisma.booking.findUniqueOrThrow({ where: { id: withHome.json.bookingId as string } });
  assert.equal(b.placeId, "geo-home");
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: (fresh.json.customer as { id: string }).id } });
  assert.equal(c.homeAddress, "12 Home St, Avon, CT 06001, USA");
  assert.equal(c.homePlaceId, "geo-home");
  // An inexact home with the hold is refused on the home field, and nothing is held.
  const another = await signUp();
  const refused = await post("/api/bookings/direct", holdBody({ homeAddress: "Farmington, CT", address: "767 New Britain Ave, Farmington, CT" }), another.cookie!);
  assert.equal(refused.status, 400);
  assert.equal(refused.json.field, "homeAddress");
});

// ---- staff bookings ---------------------------------------------------------------------
test("staff booking: never refused; checked afterwards, an exact address becomes the place, a vague one is marked not checked and staff are told", async () => {
  const policy = await prisma.policyVersion.findFirstOrThrow({ where: { accountId }, orderBy: { version: "desc" } });
  const staffBooking = (name: string, address: string, inDays: number) =>
    prisma.$transaction(async (tx) => {
      const b = await tx.booking.create({ data: { accountId, eventDate: new Date(`${day(inDays)}T00:00:00Z`), customerName: name, address, status: "Held" } });
      await tx.agreement.create({ data: { accountId, bookingId: b.id, policyVersionId: policy.id, checkboxChecked: true } });
      made.bookings.push(b.id);
      return b;
    });
  const exact = await staffBooking(`${ZZ} Staff Exact`, "767 New Britain Ave, Farmington, CT", 40);
  assert.equal((await checkBookingAddress(exact.id)).check, "verified");
  const e = await prisma.booking.findUniqueOrThrow({ where: { id: exact.id } });
  assert.equal(e.address, "767 New Britain Ave, Farmington, CT 06032, USA");
  assert.equal(e.placeId, "geo-office");
  const vague = await staffBooking(`${ZZ} Staff Vague`, "Farmington, CT", 41);
  const out = await checkBookingAddress(vague.id);
  assert.equal(out.check, "not_checked");
  const v = await prisma.booking.findUniqueOrThrow({ where: { id: vague.id } });
  assert.equal(v.address, "Farmington, CT", "a staff booking keeps what was typed");
  assert.equal(v.addressCheck, "not_checked");
  const told = await prisma.notification.findFirst({ where: { accountId, type: "address-not-checked", bookingId: vague.id } });
  assert.ok(told);
});
