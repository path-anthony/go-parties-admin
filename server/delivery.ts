import { Prisma } from "../src/generated/prisma/client.js";
import { actorFields } from "./actor.js";
import { prisma } from "./db.js";
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
let currentFetch: MapsFetch = (url, init) => fetch(url, init);
export function setMapsFetch(f: MapsFetch | null) {
  currentFetch = f ?? ((url, init) => fetch(url, init));
}
export const mapsFetch = (): MapsFetch => currentFetch;

export const mapsConfigured = (): boolean => !!process.env.GOOGLE_MAPS_SERVER_KEY?.trim();

// Place Details (Places API, New). Throws when Google cannot be reached or
// answers oddly; null when the place does not exist.
export async function lookupPlace(placeId: string): Promise<FoundPlace | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY?.trim();
  if (!key) throw new Error("no key");
  const res = await currentFetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
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

// Block A9: the columns an exact place (from server/addressLookup.ts)
// becomes on the booking: the place, its point, its parts, verified now.
// The setup pin comes from the storefront when it sent one.
export function placeColumns(place: { placeId: string; formattedAddress: string; lat: number; lng: number; components: DeliveryComponents }, pin: { setupLat?: number | null; setupLng?: number | null; setupNotes?: string | null } | null, now = new Date()) {
  return {
    placeId: place.placeId,
    deliveryComponents: place.components as unknown as Prisma.InputJsonObject,
    addressLat: place.lat,
    addressLng: place.lng,
    ...(pin && pin.setupLat !== undefined ? { setupLat: pin.setupLat ?? null, setupLng: pin.setupLng ?? null } : {}),
    ...(pin && pin.setupNotes !== undefined ? { setupNotes: pin.setupNotes || null } : {}),
    addressCheck: "verified" as string | null,
    addressCheckReason: null as string | null,
    addressCheckedAt: now as Date | null,
    addressCheckedByName: null as string | null,
    // The contract's mailing address lines come from the exact place.
    mailingAddress: `${place.components.streetNumber} ${place.components.route}`.trim() || null,
    city: place.components.city || null,
    state: place.components.state || null,
    zip: place.components.zip || null,
  };
}

// Block A9: the Google Maps link everyone gets. The exact place when the
// booking has one, else the setup pin, else the address point, else nothing.
export function bookingMapsUrl(b: { placeId?: string | null; addressLat?: number | null; addressLng?: number | null; setupLat?: number | null; setupLng?: number | null }): string | null {
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (b.placeId && num(b.addressLat) && num(b.addressLng)) return `https://www.google.com/maps/search/?api=1&query=${b.addressLat.toFixed(6)},${b.addressLng.toFixed(6)}&query_place_id=${encodeURIComponent(b.placeId)}`;
  if (num(b.setupLat) && num(b.setupLng)) return mapsUrl(b.setupLat, b.setupLng);
  return mapsUrl(b.addressLat, b.addressLng);
}

// Staff corrected the address or the pin, or looked and are satisfied.
export async function updateDelivery(bookingId: string, patch: { address?: string | null; setupLat?: number | null; setupLng?: number | null; setupNotes?: string | null; verified?: boolean }) {
  const data: Record<string, unknown> = {};
  if (patch.address !== undefined) {
    data.address = patch.address;
    // Block A9: a new address drops the old place and its check; the
    // route looks it up again afterwards.
    Object.assign(data, { placeId: null, deliveryComponents: Prisma.DbNull, addressLat: null, addressLng: null, addressCheck: null, addressCheckReason: null, addressCheckedAt: null, addressCheckedByName: null });
  }
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
