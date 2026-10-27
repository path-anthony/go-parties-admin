import { useState } from "react";
import { updateDelivery } from "../lib/api";
import type { Booking } from "../lib/types";
import { EditableCell } from "./EditableCell";

const mapsUrl = (lat: number | null, lng: number | null) => (lat !== null && lng !== null ? `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}` : null);
// A static map needs a browser key; a plain embed with the point works with none.
const embedUrl = (lat: number, lng: number) => `https://maps.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}&z=16&output=embed`;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

// Block T1. The delivery location: the address with its check, the setup
// pin on a small map, the customer's note, and the staff corrections (the
// address, the pin, the note, and "mark as checked", recorded with who did it).
export function DeliverySection({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lat = booking.setupLat ?? booking.addressLat;
  const lng = booking.setupLng ?? booking.addressLng;
  const link = mapsUrl(lat, lng);
  const check = booking.addressCheck;

  async function save(patch: Parameters<typeof updateDelivery>[1]) {
    setBusy(true);
    setError(null);
    try {
      await updateDelivery(booking.id, patch);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save");
    } finally {
      setBusy(false);
    }
  }

  if (!booking.placeId && !booking.address) return null;

  return (
    <div className="status-control" role="group" aria-label="Delivery location">
      <span className="status-now">
        <span className="detail-field-label">Delivery</span>
        {booking.placeId ? (
          <span className={`achip ${check === "verified" ? "achip-yes" : check === "needs_check" ? "achip-unchecked" : "achip-none"}`}>
            {check === "verified" ? "Address verified" : check === "needs_check" ? "Address needs a check" : "Address not checked"}
          </span>
        ) : (
          <span className="achip achip-none">Typed address, not from the map</span>
        )}
      </span>
      {booking.addressCheckReason && <span className="muted field-help">{booking.addressCheckReason}</span>}
      {booking.addressCheckedAt && (
        <span className="muted field-help">
          {booking.addressCheckedByName ? `Marked by ${booking.addressCheckedByName}` : "Checked with Google"} {when(booking.addressCheckedAt)} ET
        </span>
      )}
      {error && <span className="form-error">{error}</span>}
      {lat !== null && lng !== null && (
        <iframe title={`Map of the setup spot for ${booking.customerName}`} src={embedUrl(lat, lng)} style={{ width: "100%", height: 180, border: 0, borderRadius: 8 }} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
      )}
      <div className="detail-field">
        <span className="detail-field-label">Setup notes</span>
        <EditableCell value={booking.setupNotes ?? ""} placeholder="Add setup notes" ariaLabel={`Setup notes for ${booking.customerName}`} onSave={(v) => save({ setupNotes: v === "" ? null : v })} />
      </div>
      <div className="field-row">
        <label>
          <span className="detail-field-label">Pin latitude</span>
          <EditableCell type="number" value={booking.setupLat === null ? "" : String(booking.setupLat)} placeholder="lat" ariaLabel={`Setup latitude for ${booking.customerName}`} onSave={(v) => save({ setupLat: v === "" ? null : Number(v) })} />
        </label>
        <label>
          <span className="detail-field-label">Pin longitude</span>
          <EditableCell type="number" value={booking.setupLng === null ? "" : String(booking.setupLng)} placeholder="lng" ariaLabel={`Setup longitude for ${booking.customerName}`} onSave={(v) => save({ setupLng: v === "" ? null : Number(v) })} />
        </label>
      </div>
      <div className="form-actions">
        {link && (
          <a className="btn-secondary" href={link} target="_blank" rel="noreferrer">
            Open in Maps
          </a>
        )}
        {check !== "verified" && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => save({ verified: true })}>
            Mark the address verified
          </button>
        )}
        {check === "verified" && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => save({ verified: false })}>
            Needs another look
          </button>
        )}
      </div>
      <span className="muted field-help">The address itself is the Address field above; correcting it here keeps the pin. The crew page links to the pin once a bid is accepted.</span>
    </div>
  );
}
