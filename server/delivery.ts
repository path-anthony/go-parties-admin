import { Prisma } from "../src/generated/prisma/client.js";
import { actorFields } from "./actor.js";
import { prisma } from "./db.js";
import { safeErr } from "./log.js";
import { safeInline } from "./sanitize.js";
import { INVALID } from "./validate.js";

// Block T1. The delivery location: the address the customer picked from
// Google Places on the storefront, its point, the setup pin and a note.
// The hold stores it as sent and answers at once; afterwards the place is
// checked server-side with Google and the booking is marked "Address
// verified" or "Address needs a check" for staff. The check never blocks or
// changes a booking.

export type DeliveryComponents = { streetNumber: string; route: string; city: string; state: string; zip: string };
export type Delivery = {
  placeId: string;
  formattedAddress: string;
  components: DeliveryComponents;
  addressLat: number;
  addressLng: number;
  setupLat: number;
  setupLng: number;
  setupNotes: string;
};

export type AddressCheck = "verified" | "needs_check" | "not_checked";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const latOk = (n: number) => n >= -90 && n <= 90;
const lngOk = (n: number) => n >= -180 && n <= 180;

// The delivery object exactly as the storefront sends it (locked API), or
// null when absent or null, or INVALID with a reason.
export function parseDelivery(value: unknown): Delivery | null | { invalid: string } {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return { invalid: "delivery must be an object or null" };
  const d = value as Record<string, unknown>;
  const placeId = typeof d.placeId === "string" ? d.placeId.trim() : "";
  if (!placeId || placeId.length > 300 || !/^[A-Za-z0-9_-]+$/.test(placeId)) return { invalid: "delivery.placeId must be a Google place id" };
  const formattedAddress = typeof d.formattedAddress === "string" ? safeInline(d.formattedAddress, 300) : "";
  if (!formattedAddress) return { invalid: "delivery.formattedAddress is required" };
  const c = (d.components ?? {}) as Record<string, unknown>;
  if (typeof d.components !== "object" || d.components === null) return { invalid: "delivery.components is required" };
  const comp = (k: keyof DeliveryComponents, max: number) => (typeof c[k] === "string" ? safeInline(c[k] as string, max) : "");
  const components: DeliveryComponents = { streetNumber: comp("streetNumber", 20), route: comp("route", 120), city: comp("city", 80), state: comp("state", 40), zip: comp("zip", 20) };
  if (!components.streetNumber || !components.route) return { invalid: "delivery must be a full street address (street number and street)" };
  const addressLat = num(d.addressLat);
  const addressLng = num(d.addressLng);
  const setupLat = num(d.setupLat);
  const setupLng = num(d.setupLng);
  if (addressLat === null || addressLng === null || !latOk(addressLat) || !lngOk(addressLng)) return { invalid: "delivery.addressLat and addressLng must be coordinates" };
  if (setupLat === null || setupLng === null || !latOk(setupLat) || !lngOk(setupLng)) return { invalid: "delivery.setupLat and setupLng must be coordinates" };
  if (d.setupNotes !== undefined && d.setupNotes !== null && typeof d.setupNotes !== "string") return { invalid: "delivery.setupNotes must be text" };
  const setupNotes = typeof d.setupNotes === "string" ? safeInline(d.setupNotes, 500) : "";
  return { placeId, formattedAddress, components, addressLat, addressLng, setupLat, setupLng, setupNotes };
}

export const isInvalidDelivery = (d: ReturnType<typeof parseDelivery>): d is { invalid: string } => d !== null && typeof d === "object" && "invalid" in d;

// The columns a delivery becomes on the booking.
export function deliveryColumns(d: Delivery | null) {
  if (!d) return { placeId: null, deliveryComponents: Prisma.DbNull, addressLat: null, addressLng: null, setupLat: null, setupLng: null, setupNotes: null, addressCheck: null as string | null, addressCheckReason: null as string | null };
  return {
    placeId: d.placeId,
    deliveryComponents: d.components as Prisma.InputJsonObject,
    addressLat: d.addressLat,
    addressLng: d.addressLng,
    setupLat: d.setupLat,
    setupLng: d.setupLng,
    setupNotes: d.setupNotes || null,
    addressCheck: "not_checked" as string | null,
    addressCheckReason: null as string | null,
  };
}

// A Google Maps link to the setup pin, for crew and staff.
export function mapsUrl(lat: number | null | undefined, lng: number | null | undefined): string | null {
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

// ---- the check ---------------------------------------------------------------

export type FoundPlace = { id: string; formattedAddress: string | null; location: { lat: number; lng: number } | null; components: { types: string[]; longText: string | null; shortText: string | null }[] };

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();

// Metres between two points.
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

export const MAX_DRIFT_M = 250;

// Pure. Does what Google says about the place match what the storefront
// sent? Verified needs: the place exists, it is a street-level address (a
// street number), the street number and street match what was sent, and
// its point is within 250 m of the sent point.
export function judgeDelivery(sent: Delivery, found: FoundPlace | null): { check: AddressCheck; reason: string | null } {
  if (!found) return { check: "needs_check", reason: "Google has no place with that id." };
  const comp = (type: string, short = false) => {
    const c = found.components.find((x) => x.types.includes(type));
    return (short ? c?.shortText : c?.longText) ?? null;
  };
  const streetNumber = comp("street_number");
  const route = comp("route");
  if (!streetNumber || !route) return { check: "needs_check", reason: "Google lists this place without a street number, so it may be a town or a business rather than an address." };
  if (norm(streetNumber) !== norm(sent.components.streetNumber) || norm(route) !== norm(sent.components.route)) {
    return { check: "needs_check", reason: `Google has ${streetNumber} ${route}; the booking says ${sent.components.streetNumber} ${sent.components.route}.` };
  }
  const zip = comp("postal_code");
  if (zip && sent.components.zip && norm(zip) !== norm(sent.components.zip)) return { check: "needs_check", reason: `Google has ZIP ${zip}; the booking says ${sent.components.zip}.` };
  if (found.location) {
    const drift = distanceM(found.location, { lat: sent.addressLat, lng: sent.addressLng });
    if (drift > MAX_DRIFT_M) return { check: "needs_check", reason: `The address point is ${Math.round(drift)} m from where Google puts this address.` };
  }
  if (found.formattedAddress && norm(found.formattedAddress) !== norm(sent.formattedAddress)) {
    // Same number and street, same ZIP, same point: the wording differs
    // (a suite, "USA"), which is not a reason to doubt the address.
    return { check: "verified", reason: `Google writes it as ${found.formattedAddress}.` };
  }
  return { check: "verified", reason: null };
}

// ---- Google ------------------------------------------------------------------

export type MapsFetch = (url: string, init?: RequestInit) => Promise<Response>;
let mapsFetch: MapsFetch = (url, init) => fetch(url, init);
export function setMapsFetch(f: MapsFetch | null) {
  mapsFetch = f ?? ((url, init) => fetch(url, init));
}

export const mapsConfigured = (): boolean => !!process.env.GOOGLE_MAPS_SERVER_KEY?.trim();

// Place Details (Places API, New). Throws when Google cannot be reached or
// answers oddly; null when the place does not exist.
export async function lookupPlace(placeId: string): Promise<FoundPlace | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY?.trim();
  if (!key) throw new Error("no key");
  const res = await mapsFetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,formattedAddress,location,addressComponents" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Google answered ${res.status}`);
  const j = (await res.json()) as { id?: string; formattedAddress?: string; location?: { latitude?: number; longitude?: number }; addressComponents?: { types?: string[]; longText?: string; shortText?: string }[] };
  if (!j.id) return null;
  return {
    id: j.id,
    formattedAddress: j.formattedAddress ?? null,
    location: typeof j.location?.latitude === "number" && typeof j.location?.longitude === "number" ? { lat: j.location.latitude, lng: j.location.longitude } : null,
    components: (j.addressComponents ?? []).map((c) => ({ types: c.types ?? [], longText: c.longText ?? null, shortText: c.shortText ?? null })),
  };
}

// Runs after the hold's reply. Writes the outcome on the booking; a failure
// to reach Google leaves it "not checked" with the reason, never an error.
export async function verifyBookingAddress(bookingId: string): Promise<{ check: AddressCheck; reason: string | null }> {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { placeId: true, deliveryComponents: true, addressLat: true, addressLng: true, setupLat: true, setupLng: true, setupNotes: true, address: true } });
  if (!b || !b.placeId || b.addressLat === null || b.addressLng === null) return { check: "not_checked", reason: "No place was sent with this booking." };
  if (!mapsConfigured()) {
    const out = { check: "not_checked" as const, reason: "Address checking is not set up (no Google Maps key)." };
    await prisma.booking.update({ where: { id: bookingId }, data: { addressCheck: out.check, addressCheckReason: out.reason } });
    return out;
  }
  const sent: Delivery = {
    placeId: b.placeId,
    formattedAddress: b.address ?? "",
    components: (b.deliveryComponents ?? { streetNumber: "", route: "", city: "", state: "", zip: "" }) as DeliveryComponents,
    addressLat: b.addressLat,
    addressLng: b.addressLng,
    setupLat: b.setupLat ?? b.addressLat,
    setupLng: b.setupLng ?? b.addressLng,
    setupNotes: b.setupNotes ?? "",
  };
  let out: { check: AddressCheck; reason: string | null };
  try {
    out = judgeDelivery(sent, await lookupPlace(b.placeId));
  } catch (err) {
    out = { check: "not_checked", reason: `Google could not be reached (${safeErr(err)}). Check the address by hand.` };
  }
  await prisma.booking.update({ where: { id: bookingId }, data: { addressCheck: out.check, addressCheckReason: out.reason, addressCheckedAt: out.check === "not_checked" ? null : new Date(), addressCheckedByName: null } });
  return out;
}

// Staff corrected the address or the pin, or looked and are satisfied.
export async function updateDelivery(bookingId: string, patch: { address?: string | null; setupLat?: number | null; setupLng?: number | null; setupNotes?: string | null; verified?: boolean }) {
  const data: Record<string, unknown> = {};
  if (patch.address !== undefined) data.address = patch.address;
  if (patch.setupLat !== undefined) data.setupLat = patch.setupLat;
  if (patch.setupLng !== undefined) data.setupLng = patch.setupLng;
  if (patch.setupNotes !== undefined) data.setupNotes = patch.setupNotes;
  const who = actorFields();
  if (patch.verified === true) {
    data.addressCheck = "verified";
    data.addressCheckReason = `Checked by ${who.userName ?? "staff"}.`;
    data.addressCheckedAt = new Date();
    data.addressCheckedByName = who.userName ?? "staff";
  } else if (patch.verified === false) {
    data.addressCheck = "needs_check";
    data.addressCheckReason = `Marked for a check by ${who.userName ?? "staff"}.`;
    data.addressCheckedAt = new Date();
    data.addressCheckedByName = who.userName ?? "staff";
  }
  if (Object.keys(data).length === 0) return INVALID;
  return prisma.booking.update({ where: { id: bookingId }, data });
}
