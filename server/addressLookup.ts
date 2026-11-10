import { Prisma } from "../src/generated/prisma/client.js";
import { prisma } from "./db.js";
import { type AddressCheck, type DeliveryComponents, mapsConfigured, type MapsFetch, mapsFetch, placeColumns } from "./delivery.js";
import { safeErr } from "./log.js";
import { createNotifications } from "./notifications.js";
import { takeDaily, usedToday } from "./usage.js";
import { todayEastern } from "./validate.js";

// Block A9. One address lookup for everything: the hold, the quote, the
// customer's home address, a staff booking, the Integrations card. A place
// id goes to Places API (New) Place Details; typed text goes to the
// Geocoding API. The answer is "exact" (a street address with a number,
// placed on the rooftop or along the street, in the United States), a clear
// "not exact" with the reason, or "unavailable" (no key, Google down, the
// daily cap). Only "not exact" ever refuses a booking.
//
// Cost guard: answers are kept 30 days by place id and by normalized text,
// and the calls are counted per Eastern day; past MAPS_DAILY_CAP nothing is
// called and staff are told once.

export type ExactPlace = { placeId: string; formattedAddress: string; lat: number; lng: number; components: DeliveryComponents };
export type LookupOutcome = { kind: "exact"; place: ExactPlace; cached: boolean } | { kind: "not-exact"; reason: string; cached: boolean } | { kind: "unavailable"; reason: string };

export const MAPS_DAILY_CAP = 500;
export const CACHE_DAYS = 30;
export const NOT_EXACT_MESSAGE = "We couldn't find that exact address. Pick it from the suggestions, or check the street number.";

const EXACT_TYPES = new Set(["street_address", "premise", "subpremise"]);
const EXACT_LOCATION = new Set(["ROOFTOP", "RANGE_INTERPOLATED"]);

export const normalizeAddressText = (s: string): string => s.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
export const cacheKeyFor = (q: { placeId?: string | null; text?: string | null }): string | null => (q.placeId ? `place:${q.placeId}` : q.text?.trim() ? `text:${normalizeAddressText(q.text)}` : null);

// ---- judging an answer (pure) ------------------------------------------------

type Component = { types: string[]; long: string | null; short: string | null };
type Candidate = { placeId: string | null; formattedAddress: string | null; lat: number | null; lng: number | null; types: string[]; components: Component[]; locationType: string | null };

const pick = (cs: Component[], type: string, short = false) => {
  const c = cs.find((x) => x.types.includes(type));
  return (short ? c?.short : c?.long) ?? null;
};

// Why a candidate is not an exact address, or null when it is.
export function judgeCandidate(c: Candidate): { place: ExactPlace } | { reason: string } {
  const country = pick(c.components, "country", true);
  if (country && country.toUpperCase() !== "US") return { reason: "That address is outside the United States." };
  const streetNumber = pick(c.components, "street_number");
  const route = pick(c.components, "route");
  if (!c.types.some((t) => EXACT_TYPES.has(t)) || !streetNumber || !route) return { reason: "Google has this as an area or a place without a street number, not a street address." };
  if (c.locationType !== null && !EXACT_LOCATION.has(c.locationType)) return { reason: "Google can only place this address roughly, not at the street number." };
  if (!country) return { reason: "Google did not say which country this address is in." };
  if (!c.placeId || !c.formattedAddress || c.lat === null || c.lng === null) return { reason: "Google answered without a place id, address or point." };
  const components: DeliveryComponents = {
    streetNumber,
    route,
    city: pick(c.components, "locality") ?? pick(c.components, "sublocality") ?? pick(c.components, "neighborhood") ?? "",
    state: pick(c.components, "administrative_area_level_1", true) ?? "",
    zip: pick(c.components, "postal_code") ?? "",
  };
  return { place: { placeId: c.placeId, formattedAddress: c.formattedAddress, lat: c.lat, lng: c.lng, components } };
}

// Geocoding API result -> candidate.
export function geocodeCandidate(r: { place_id?: string; formatted_address?: string; types?: string[]; geometry?: { location?: { lat?: number; lng?: number }; location_type?: string }; address_components?: { types?: string[]; long_name?: string; short_name?: string }[] }): Candidate {
  const lat = r.geometry?.location?.lat;
  const lng = r.geometry?.location?.lng;
  return {
    placeId: r.place_id ?? null,
    formattedAddress: r.formatted_address ?? null,
    lat: typeof lat === "number" ? lat : null,
    lng: typeof lng === "number" ? lng : null,
    types: r.types ?? [],
    components: (r.address_components ?? []).map((c) => ({ types: c.types ?? [], long: c.long_name ?? null, short: c.short_name ?? null })),
    locationType: r.geometry?.location_type ?? null,
  };
}

// Places API (New) Place Details -> candidate. It has no location type.
export function placeCandidate(p: { id?: string; formattedAddress?: string; types?: string[]; location?: { latitude?: number; longitude?: number }; addressComponents?: { types?: string[]; longText?: string; shortText?: string }[] }): Candidate {
  return {
    placeId: p.id ?? null,
    formattedAddress: p.formattedAddress ?? null,
    lat: typeof p.location?.latitude === "number" ? p.location.latitude : null,
    lng: typeof p.location?.longitude === "number" ? p.location.longitude : null,
    types: p.types ?? [],
    components: (p.addressComponents ?? []).map((c) => ({ types: c.types ?? [], long: c.longText ?? null, short: c.shortText ?? null })),
    locationType: null,
  };
}

// ---- Google ----------------------------------------------------------------------

type Answer = { place: ExactPlace } | { reason: string };

async function askGoogle(q: { placeId?: string | null; text?: string | null }, fetchFn: MapsFetch): Promise<Answer> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY?.trim();
  if (!key) throw new Error("no key");
  if (q.placeId) {
    const res = await fetchFn(`https://places.googleapis.com/v1/places/${encodeURIComponent(q.placeId)}`, {
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,formattedAddress,location,addressComponents,types" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { reason: "Google has no place with that id." };
    if (!res.ok) throw new Error(`Google answered ${res.status}`);
    const j = (await res.json()) as Parameters<typeof placeCandidate>[0];
    if (!j.id) return { reason: "Google has no place with that id." };
    return judgeCandidate(placeCandidate(j));
  }
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", q.text ?? "");
  url.searchParams.set("region", "us");
  url.searchParams.set("key", key);
  const res = await fetchFn(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Google answered ${res.status}`);
  const j = (await res.json()) as { status?: string; results?: Parameters<typeof geocodeCandidate>[0][]; error_message?: string };
  if (j.status === "ZERO_RESULTS" || (j.status === "OK" && (j.results ?? []).length === 0)) return { reason: "Google could not find that address." };
  if (j.status !== "OK") throw new Error(`Google answered ${j.status ?? "nothing"}`);
  const results = j.results ?? [];
  // One exact match among several is still the answer (Google lists the
  // best first); an answer that is only areas is not.
  for (const r of results) {
    const judged = judgeCandidate(geocodeCandidate(r));
    if ("place" in judged) return judged;
  }
  return judgeCandidate(geocodeCandidate(results[0]));
}

// ---- the cache, the counter, the last error -----------------------------------

function fromRow(row: { exact: boolean; placeId: string | null; formattedAddress: string | null; lat: number | null; lng: number | null; components: unknown; reason: string | null }): LookupOutcome {
  if (row.exact && row.placeId && row.formattedAddress && row.lat !== null && row.lng !== null) {
    return { kind: "exact", cached: true, place: { placeId: row.placeId, formattedAddress: row.formattedAddress, lat: row.lat, lng: row.lng, components: (row.components ?? { streetNumber: "", route: "", city: "", state: "", zip: "" }) as DeliveryComponents } };
  }
  return { kind: "not-exact", cached: true, reason: row.reason ?? NOT_EXACT_MESSAGE };
}

async function remember(key: string, answer: Answer, now: Date): Promise<void> {
  const expiresAt = new Date(now.getTime() + CACHE_DAYS * 86_400_000);
  const data = "place" in answer
    ? { exact: true, placeId: answer.place.placeId, formattedAddress: answer.place.formattedAddress, lat: answer.place.lat, lng: answer.place.lng, components: answer.place.components as unknown as Prisma.InputJsonObject, reason: null, expiresAt }
    : { exact: false, placeId: null, formattedAddress: null, lat: null, lng: null, components: Prisma.DbNull, reason: answer.reason, expiresAt };
  await prisma.addressLookup.upsert({ where: { key }, create: { key, ...data }, update: data }).catch((err) => console.warn("[maps] cache write failed:", safeErr(err)));
}
async function recordError(accountId: string, message: string, now: Date): Promise<void> {
  await prisma.account.update({ where: { id: accountId }, data: { mapsLastError: message.slice(0, 300), mapsLastErrorAt: now } }).catch(() => undefined);
}

async function pausedNotice(accountId: string, now: Date): Promise<void> {
  const day = todayEastern(now);
  await createNotifications([{ accountId, type: "address-checks-paused", title: "Address checks paused for today", body: `${MAPS_DAILY_CAP} Google Maps lookups were made today. Until tomorrow, addresses are saved as typed and marked not checked.`, link: "/settings/integrations", dedupeKey: `address-checks-paused:${day}` }]).catch(() => undefined);
}

// The one entry point. Never throws.
export async function lookupAddress(accountId: string, q: { placeId?: string | null; text?: string | null }, now = new Date()): Promise<LookupOutcome> {
  const key = cacheKeyFor(q);
  if (!key) return { kind: "unavailable", reason: "No address was given." };
  try {
    const hit = await prisma.addressLookup.findUnique({ where: { key } });
    if (hit && hit.expiresAt.getTime() > now.getTime()) return fromRow(hit);
  } catch (err) {
    console.warn("[maps] cache read failed:", safeErr(err));
  }
  if (!mapsConfigured()) return { kind: "unavailable", reason: "Address checking is not set up (no Google Maps key)." };
  if (!(await takeDaily(accountId, "maps_lookup", MAPS_DAILY_CAP, now))) {
    await pausedNotice(accountId, now);
    return { kind: "unavailable", reason: "Address checks are paused for today (daily limit reached)." };
  }
  let answer: Answer;
  try {
    answer = await askGoogle(q, mapsFetch());
  } catch (err) {
    const why = safeErr(err);
    console.warn("[maps] lookup failed:", why);
    await recordError(accountId, why, now);
    return { kind: "unavailable", reason: `Google could not be reached (${why}). Check the address by hand.` };
  }
  await remember(key, answer, now);
  return "place" in answer ? { kind: "exact", place: answer.place, cached: false } : { kind: "not-exact", reason: answer.reason, cached: false };
}

export async function mapsStatus(accountId: string, now = new Date()) {
  const a = await prisma.account.findUnique({ where: { id: accountId }, select: { mapsLastError: true, mapsLastErrorAt: true } });
  return { configured: mapsConfigured(), todayLookups: await usedToday(accountId, "maps_lookup", now), dailyCap: MAPS_DAILY_CAP, lastError: a?.mapsLastError ?? null, lastErrorAt: a?.mapsLastErrorAt ?? null };
}

// ---- a booking's address, after the fact ------------------------------------------

// Looks up a booking's address (by place id when it has one, else the typed
// text) and writes what came back: an exact place becomes the verified
// address with its point; anything else leaves the address as typed and
// marked not checked with the reason. Never refuses, never throws. Used for
// staff bookings and for an address staff changed.
export async function checkBookingAddress(bookingId: string, now = new Date()): Promise<{ check: AddressCheck; reason: string | null }> {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { accountId: true, placeId: true, address: true, setupLat: true, setupLng: true, customerName: true } });
  if (!b || (!b.placeId && !b.address?.trim())) return { check: "not_checked", reason: "No address was given." };
  const outcome = await lookupAddress(b.accountId, b.placeId ? { placeId: b.placeId } : { text: b.address }, now);
  if (outcome.kind === "exact") {
    await prisma.booking.update({ where: { id: bookingId }, data: { address: outcome.place.formattedAddress, ...placeColumns(outcome.place, { setupLat: b.setupLat, setupLng: b.setupLng }, now) } });
    return { check: "verified", reason: null };
  }
  const out = { check: "not_checked" as const, reason: outcome.reason };
  await prisma.booking.update({ where: { id: bookingId }, data: { addressCheck: out.check, addressCheckReason: out.reason, addressCheckedAt: null, addressCheckedByName: null } });
  await createNotifications([{ accountId: b.accountId, type: "address-not-checked", title: "Address not checked", body: `${b.customerName}: ${out.reason}`, link: `/scheduling/bookings?booking=${bookingId}`, bookingId, dedupeKey: `address-not-checked:${bookingId}:${cacheKeyFor(b.placeId ? { placeId: b.placeId } : { text: b.address }) ?? ""}` }]).catch(() => undefined);
  return out;
}
