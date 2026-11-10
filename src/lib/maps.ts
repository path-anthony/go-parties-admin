import type { Booking } from "./types";

const point = (lat: number | null, lng: number | null) => (lat !== null && lng !== null ? `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}` : null);

// Block A9: the same rule as the server's bookingMapsUrl: the exact place
// when there is one, else the setup pin, else the address point.
export function bookingMapsUrl(b: Pick<Booking, "placeId" | "addressLat" | "addressLng" | "setupLat" | "setupLng">): string | null {
  if (b.placeId && b.addressLat !== null && b.addressLng !== null) return `https://www.google.com/maps/search/?api=1&query=${b.addressLat.toFixed(6)},${b.addressLng.toFixed(6)}&query_place_id=${encodeURIComponent(b.placeId)}`;
  return point(b.setupLat, b.setupLng) ?? point(b.addressLat, b.addressLng);
}
