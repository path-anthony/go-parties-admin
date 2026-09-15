import { type FormEvent, useEffect, useState } from "react";
import { createBooking, createUnit, getBookings, getItems, getLeads, getUnits, updateBooking, updateUnit } from "../../lib/api";
import { leadTitle } from "../../lib/leads";
import {
  BOOKING_STATUSES,
  UNIT_STATUSES,
  type Booking,
  type BookingPatch,
  type BookingStatus,
  type Item,
  type Lead,
  type NewBooking,
  type NewUnit,
  type Unit,
  type UnitPatch,
  type UnitStatus,
} from "../../lib/types";
import { EditableCell } from "../EditableCell";

type ItemsById = Map<string, Item>;

function itemLabel(item: Item | undefined): string {
  return item ? `${item.name} · ${item.category}` : "Unknown item";
}

function unitLabel(unit: Unit, itemsById: ItemsById): string {
  return `${itemsById.get(unit.itemId)?.name ?? "Unknown item"} · ${unit.label}`;
}

function leadLabel(lead: Lead): string {
  return leadTitle(lead) ?? (lead.theme ? lead.theme.slice(0, 40) : "Lead");
}

function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function sortUnits(units: Unit[], itemsById: ItemsById): Unit[] {
  return [...units].sort(
    (a, b) =>
      (itemsById.get(a.itemId)?.name ?? "").localeCompare(itemsById.get(b.itemId)?.name ?? "") ||
      a.label.localeCompare(b.label),
  );
}

function sortBookings(bookings: Booking[]): Booking[] {
  return [...bookings].sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.createdAt.localeCompare(b.createdAt));
}

export function SchedulingScreen() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getItems(), getUnits(), getBookings(), getLeads()])
      .then(([itemList, unitList, bookingList, leadList]) => {
        setItems(sortItems(itemList));
        setUnits(unitList);
        setBookings(bookingList);
        setLeads(leadList);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  const ready = items !== null && units !== null && bookings !== null && leads !== null;
  const itemsById: ItemsById = new Map((items ?? []).map((item) => [item.id, item]));

  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Scheduling</h2>
        <p className="muted">Physical units per item, and confirmed bookings. No calendar yet.</p>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!ready && !error && <p className="muted">Loading…</p>}

      {ready && (
        <>
          <section className="panel">
            <h2>Units ({units.length})</h2>
            <AddUnitForm items={items} onAdded={(unit) => setUnits((prev) => sortUnits([...(prev ?? []), unit], itemsById))} />
            {units.length === 0 ? (
              <p className="muted">Nothing here yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="items-table scheduling-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Label</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {units.map((unit) => (
                      <UnitRow
                        key={unit.id}
                        unit={unit}
                        item={itemsById.get(unit.itemId)}
                        onUpdated={(updated) =>
                          setUnits((prev) => (prev ?? []).map((u) => (u.id === updated.id ? updated : u)))
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <h2>Bookings ({bookings.length})</h2>
            <AddBookingForm
              leads={leads}
              units={units}
              itemsById={itemsById}
              onAdded={(booking) => setBookings((prev) => sortBookings([...(prev ?? []), booking]))}
            />
            {bookings.length === 0 ? (
              <p className="muted">Nothing here yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="items-table scheduling-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Customer</th>
                      <th>Contact</th>
                      <th>Status</th>
                      <th>Deposit</th>
                      <th>Lead</th>
                      <th>Units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookings.map((booking) => (
                      <BookingRow
                        key={booking.id}
                        booking={booking}
                        leads={leads}
                        units={units}
                        itemsById={itemsById}
                        onUpdated={(updated) =>
                          setBookings((prev) => sortBookings((prev ?? []).map((b) => (b.id === updated.id ? updated : b))))
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function AddUnitForm({ items, onAdded }: { items: Item[]; onAdded: (unit: Unit) => void }) {
  const [form, setForm] = useState<NewUnit>({ itemId: items[0]?.id ?? "", label: "", status: "Available" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onAdded(await createUnit(form));
      setForm((f) => ({ ...f, label: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add unit");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <label>
        Item
        <select value={form.itemId} onChange={(e) => setForm((f) => ({ ...f, itemId: e.target.value }))} required>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {itemLabel(item)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Label
        <input
          value={form.label}
          onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          placeholder="e.g. Generator #2"
          required
        />
      </label>
      <label>
        Status
        <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as UnitStatus }))}>
          {UNIT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn-primary" disabled={saving || items.length === 0}>
        {saving ? "Adding…" : "Add unit"}
      </button>
      {error && <p className="form-error inline-form-wide">{error}</p>}
    </form>
  );
}

function UnitRow({ unit, item, onUpdated }: { unit: Unit; item: Item | undefined; onUpdated: (unit: Unit) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: UnitPatch) {
    onUpdated(await updateUnit(unit.id, patch));
  }

  async function handleStatus(status: UnitStatus) {
    setSaving(true);
    setError(null);
    try {
      await save({ status });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr>
      <td>
        {item?.name ?? "Unknown item"}
        {item && <span className="muted"> · {item.category}</span>}
      </td>
      <td>
        <EditableCell value={unit.label} ariaLabel={`Label for ${unit.label}`} onSave={(label) => save({ label })} />
      </td>
      <td>
        <select
          value={unit.status}
          onChange={(e) => handleStatus(e.target.value as UnitStatus)}
          disabled={saving}
          aria-label={`Status for ${unit.label}`}
        >
          {UNIT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        {saving && <span className="cell-status">Saving…</span>}
        {error && <p className="form-error booking-row-error">{error}</p>}
      </td>
    </tr>
  );
}

function UnitPicker({
  units,
  itemsById,
  selected,
  disabled,
  onToggle,
}: {
  units: Unit[];
  itemsById: ItemsById;
  selected: string[];
  disabled?: boolean;
  onToggle: (unitId: string, checked: boolean) => void;
}) {
  if (units.length === 0) return <p className="muted">No units yet. Add one above.</p>;
  return (
    <div className="unit-picker">
      {units.map((unit) => (
        <label key={unit.id}>
          <input
            type="checkbox"
            checked={selected.includes(unit.id)}
            disabled={disabled}
            onChange={(e) => onToggle(unit.id, e.target.checked)}
          />
          {unitLabel(unit, itemsById)}
          <span className="muted"> · {unit.status}</span>
        </label>
      ))}
    </div>
  );
}

const EMPTY_BOOKING: NewBooking = {
  leadId: null,
  eventDate: "",
  customerName: "",
  customerContact: "",
  status: "Confirmed",
  unitIds: [],
};

function AddBookingForm({
  leads,
  units,
  itemsById,
  onAdded,
}: {
  leads: Lead[];
  units: Unit[];
  itemsById: ItemsById;
  onAdded: (booking: Booking) => void;
}) {
  const [form, setForm] = useState<NewBooking>(EMPTY_BOOKING);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof NewBooking>(key: K, value: NewBooking[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Picking a lead fills in whatever it already knows, without overwriting
  // anything typed by hand.
  function pickLead(leadId: string) {
    const lead = leads.find((l) => l.id === leadId) ?? null;
    setForm((f) => ({
      ...f,
      leadId: lead ? lead.id : null,
      customerName: f.customerName || lead?.customerName || "",
      customerContact: f.customerContact || lead?.contact || "",
      eventDate: f.eventDate || lead?.dateOfInterest?.slice(0, 10) || "",
    }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onAdded(await createBooking(form));
      setForm(EMPTY_BOOKING);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add booking");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <label>
        Lead (optional)
        <select value={form.leadId ?? ""} onChange={(e) => pickLead(e.target.value)}>
          <option value="">No lead</option>
          {leads.map((lead) => (
            <option key={lead.id} value={lead.id}>
              {leadLabel(lead)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Event date*
        <input type="date" value={form.eventDate} onChange={(e) => set("eventDate", e.target.value)} required />
      </label>
      <label>
        Customer name*
        <input value={form.customerName} onChange={(e) => set("customerName", e.target.value)} required />
      </label>
      <label>
        Phone or email*
        <input value={form.customerContact} onChange={(e) => set("customerContact", e.target.value)} required />
      </label>
      <label>
        Status
        <select value={form.status} onChange={(e) => set("status", e.target.value as BookingStatus)}>
          {BOOKING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      <div className="inline-form-wide">
        <span className="detail-field-label">Units</span>
        <UnitPicker
          units={units}
          itemsById={itemsById}
          selected={form.unitIds}
          onToggle={(unitId, checked) =>
            set("unitIds", checked ? [...form.unitIds, unitId] : form.unitIds.filter((id) => id !== unitId))
          }
        />
      </div>
      <button type="submit" className="btn-primary" disabled={saving}>
        {saving ? "Adding…" : "Add booking"}
      </button>
      {error && <p className="form-error inline-form-wide">{error}</p>}
    </form>
  );
}

function BookingRow({
  booking,
  leads,
  units,
  itemsById,
  onUpdated,
}: {
  booking: Booking;
  leads: Lead[];
  units: Unit[];
  itemsById: ItemsById;
  onUpdated: (booking: Booking) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: BookingPatch) {
    onUpdated(await updateBooking(booking.id, patch));
  }

  // For the controls that save on change (selects, checkboxes); the text
  // fields use EditableCell, which carries its own saving state.
  async function saveNow(patch: BookingPatch) {
    setSaving(true);
    setError(null);
    try {
      await save(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const linkedUnits = booking.unitIds.map((id) => units.find((u) => u.id === id)).filter((u): u is Unit => !!u);

  return (
    <tr>
      <td>
        <EditableCell
          type="date"
          value={booking.eventDate.slice(0, 10)}
          ariaLabel={`Event date for ${booking.customerName}`}
          onSave={(eventDate) => save({ eventDate })}
        />
      </td>
      <td>
        <EditableCell
          value={booking.customerName}
          ariaLabel={`Customer name for ${booking.customerName}`}
          onSave={(customerName) => save({ customerName })}
        />
      </td>
      <td>
        <EditableCell
          value={booking.customerContact}
          ariaLabel={`Contact for ${booking.customerName}`}
          onSave={(customerContact) => save({ customerContact })}
        />
      </td>
      <td>
        <select
          value={booking.status}
          onChange={(e) => saveNow({ status: e.target.value as BookingStatus })}
          disabled={saving}
          aria-label={`Status for ${booking.customerName}`}
        >
          {BOOKING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </td>
      <td>
        <label className="deposit-flag">
          <input
            type="checkbox"
            checked={booking.depositPaid}
            disabled={saving}
            onChange={(e) => saveNow({ depositPaid: e.target.checked })}
            aria-label={`Deposit paid for ${booking.customerName}`}
          />
          {booking.depositPaid ? "Paid" : "Not yet"}
        </label>
      </td>
      <td>
        <select
          value={booking.leadId ?? ""}
          onChange={(e) => saveNow({ leadId: e.target.value || null })}
          disabled={saving}
          aria-label={`Lead for ${booking.customerName}`}
        >
          <option value="">No lead</option>
          {leads.map((lead) => (
            <option key={lead.id} value={lead.id}>
              {leadLabel(lead)}
            </option>
          ))}
        </select>
      </td>
      <td>
        <div className="booking-units">
          {linkedUnits.length === 0 && <span className="muted">None</span>}
          {linkedUnits.map((unit) => (
            <span key={unit.id} className="tag-chip">
              {unitLabel(unit, itemsById)}
            </span>
          ))}
          <details>
            <summary>Edit</summary>
            <UnitPicker
              units={units}
              itemsById={itemsById}
              selected={booking.unitIds}
              disabled={saving}
              onToggle={(unitId, checked) =>
                saveNow({
                  unitIds: checked ? [...booking.unitIds, unitId] : booking.unitIds.filter((id) => id !== unitId),
                })
              }
            />
          </details>
        </div>
        {saving && <span className="cell-status">Saving…</span>}
        {error && <p className="form-error booking-row-error">{error}</p>}
      </td>
    </tr>
  );
}
