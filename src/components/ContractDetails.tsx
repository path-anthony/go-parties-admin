import { useEffect, useState } from "react";
import { getContractStatus, getServiceRows } from "../lib/api";
import type { Booking, BookingPatch, ContractStatusInfo, ServiceRow, ServiceRowOverride } from "../lib/types";
import { EditableCell } from "./EditableCell";

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Everything the GO contract prints beyond the booking itself, and which
// contract this booking gets. The four required things are marked, and the
// plain-English reason the contract can't go yet comes from the server (the
// same check the send uses).
export function ContractDetails({ booking, onSave, onContractStateChange }: { booking: Booking; onSave: (patch: BookingPatch) => Promise<void>; onContractStateChange?: (s: ContractStatusInfo) => void }) {
  const [status, setStatus] = useState<ContractStatusInfo | null>(null);
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    getContractStatus(booking.id)
      .then((s) => {
        setStatus(s);
        onContractStateChange?.(s);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't check the contract"));
  }
  // The readiness line follows every save of a detail.
  useEffect(refresh, [booking.id, booking.venueName, booking.onsiteContactName, booking.onsiteContactPhone, booking.expectedGuests, booking.timeFrom, booking.timeTo, booking.agreement?.contractStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    getServiceRows()
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]));
  }, []);

  const who = booking.customerName;
  const text = (label: string, key: keyof Booking & keyof BookingPatch, required = false, placeholder = "Add") => (
    <div className="detail-field">
      <span className="detail-field-label">
        {label}
        {required ? " *" : ""}
      </span>
      <EditableCell value={(booking[key] as string | null) ?? ""} placeholder={placeholder} ariaLabel={`${label} for ${who}`} onSave={(v) => onSave({ [key]: v === "" ? null : v } as BookingPatch)} />
    </div>
  );
  const number = (label: string, key: "expectedGuests" | "discountPercent" | "discountAmount", required = false) => (
    <div className="detail-field">
      <span className="detail-field-label">
        {label}
        {required ? " *" : ""}
      </span>
      <EditableCell
        type="number"
        value={booking[key] === null ? "" : String(booking[key])}
        placeholder="Add"
        ariaLabel={`${label} for ${who}`}
        onSave={(v) => onSave({ [key]: v === "" ? null : Number(v) } as BookingPatch)}
      />
    </div>
  );
  const overrides = booking.contractServices ?? {};
  const setOverride = (rowId: string, patch: ServiceRowOverride) => {
    const next: Record<string, ServiceRowOverride> = { ...overrides, [rowId]: { ...(overrides[rowId] ?? {}), ...patch } };
    // Dropping every override of a row removes the row's entry.
    const entry = next[rowId];
    if (entry.checked === null && (entry.details === null || entry.details === undefined) && (entry.feeCents === null || entry.feeCents === undefined)) delete next[rowId];
    return onSave({ contractServices: Object.keys(next).length === 0 ? null : next });
  };

  return (
    <div className="modal-section" aria-label="Contract details">
      <span className="detail-field-label">Contract details</span>
      {status && (
        <p className={status.format === "go-v2" && status.readiness ? "stage-warning" : "muted"}>
          {status.format === "go-v2"
            ? status.readiness ?? (status.decided ? "This booking's contract is the GO contract." : "This booking will get the GO contract.")
            : status.decided
              ? "This booking's contract uses the original layout with the policy text."
              : "This booking will get the original layout with the policy text. Turn on the GO contract under Settings, Contract settings to change that for contracts not yet sent."}
          {status.format === "go-v2" && !status.goSignerConfigured && " GO's signer is not set under Settings, Policies; the contract will go out without GO's signature."}
          {status.goSigner && ` GO signed as ${status.goSigner.printedName}.`}
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      <p className="muted addon-help">Fields marked * are needed before the GO contract can be sent. The venue address is the booking's address above.</p>
      <div className="catalog-detail">
        {text("Venue name", "venueName", true)}
        {text("Venue phone", "venuePhone")}
        {text("On-site contact name", "onsiteContactName", true)}
        {text("On-site contact phone", "onsiteContactPhone", true)}
        {text("Time from", "timeFrom", true, "2 PM")}
        {text("Time to", "timeTo", true, "6 PM")}
        {number("Expected guests", "expectedGuests", true)}
        {text("Guest of honor", "guestOfHonor")}
        {text("Age range", "ageRange")}
        {text("Planner / coordinator", "planner")}
        {text("Mailing address", "mailingAddress")}
        {text("City", "city")}
        {text("State", "state")}
        {text("ZIP", "zip")}
        {text("Phone, home", "phoneHome")}
        {text("Phone, work", "phoneWork")}
        {text("Phone, cell", "phoneCell", false, "Uses the booking phone if blank")}
        {number("Discount (%)", "discountPercent")}
        {number("Discount ($)", "discountAmount")}
        {text("Discount description / code", "discountDescription")}
        <div className="detail-field detail-field-span">
          <span className="detail-field-label">Special requests</span>
          <EditableCell value={booking.specialRequests ?? ""} placeholder="Add" ariaLabel={`Special requests for ${who}`} onSave={(v) => onSave({ specialRequests: v === "" ? null : v })} />
        </div>
      </div>
      {rows.length > 0 && (
        <details className="service-overrides">
          <summary>Services table overrides ({Object.keys(overrides).length})</summary>
          <p className="muted addon-help">The booked items fill the table on their own. Set a row here only to change what it shows: tick or untick it, write your own details, or set the fee.</p>
          <ul className="addon-list">
            {rows
              .filter((r) => !r.isGroupHeading)
              .map((r) => {
                const o = overrides[r.id] ?? {};
                return (
                  <li key={r.id} className="service-override-row">
                    <label className="checkbox-label">
                      <input type="checkbox" checked={o.checked === true} ref={(el) => {
                          if (el) el.indeterminate = o.checked === undefined || o.checked === null;
                        }} onChange={(e) => setOverride(r.id, { checked: e.target.checked })} />
                      {r.label}
                    </label>
                    <EditableCell value={o.details ?? ""} placeholder="Details (automatic)" ariaLabel={`Details for ${r.label}`} onSave={(v) => setOverride(r.id, { details: v === "" ? null : v })} />
                    <EditableCell
                      type="number"
                      value={o.feeCents === undefined || o.feeCents === null ? "" : String(o.feeCents / 100)}
                      placeholder="Fee (automatic)"
                      ariaLabel={`Fee for ${r.label}`}
                      onSave={(v) => setOverride(r.id, { feeCents: v === "" ? null : Math.round(Number(v) * 100) })}
                    />
                    {(o.checked !== undefined && o.checked !== null) || o.details || o.feeCents !== undefined ? (
                      <button type="button" className="link-button" onClick={() => setOverride(r.id, { checked: null, details: null, feeCents: null })}>
                        Automatic
                      </button>
                    ) : (
                      <span className="muted">{o.feeCents != null ? usd(o.feeCents) : ""}</span>
                    )}
                  </li>
                );
              })}
          </ul>
        </details>
      )}
    </div>
  );
}
