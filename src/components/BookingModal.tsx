import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { addBookingUnit, removeBookingUnit, setBookingAddons, updateBooking } from "../lib/api";
import { deltaLabel, describeAddon } from "../lib/addons";
import { leadTitle } from "../lib/leads";
import {
  BOOKING_STATUSES,
  type AddonGroup,
  type Booking,
  type BookingAddon,
  type BookingPatch,
  type BookingStatus,
  type Item,
  type Lead,
  type Unit,
} from "../lib/types";
import { EditableCell } from "./EditableCell";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function leadLabel(lead: Lead): string {
  return leadTitle(lead) ?? (lead.theme ? lead.theme.slice(0, 40) : "Lead");
}

// How many units of an item are open on a date, from what this screen
// already has loaded. It's only for the labels in the "add an item" list;
// the server decides for real, under a lock, when a unit is added.
function freeCount(item: Item, date: string, units: Unit[], bookings: Booking[]): number {
  const held = new Set(bookings.filter((b) => b.eventDate.slice(0, 10) === date).flatMap((b) => b.unitIds));
  return units.filter((u) => u.itemId === item.id && u.status === "Available" && !held.has(u.id)).length;
}

// Everything about one booking, in a popup like the item and package ones.
// Text fields save when they're left; selects and checkboxes save on
// change. A date change is a reschedule: the server re-claims a free unit
// of every item on the new date under the same lock a customer's booking
// uses, or refuses and leaves the booking alone. Adding an item claims a
// unit the same way.
export function BookingModal({
  booking,
  leads,
  units,
  items,
  bookings,
  onUpdated,
  onClose,
}: {
  booking: Booking;
  leads: Lead[];
  units: Unit[];
  items: Item[];
  bookings: Booking[];
  onUpdated: (booking: Booking) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Refusals from the click and change controls (adding a unit to a full
  // date, an add-on the item doesn't offer) are shown in full here.
  const [notice, setNotice] = useState<string | null>(null);
  const [addItemId, setAddItemId] = useState("");

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      const target = e.target;
      if (target instanceof HTMLElement && target.matches("input, textarea, select")) {
        target.blur();
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // For the save-on-blur fields. A refusal (a date with nothing free, say)
  // is shown in full by the field itself, right under it, so it isn't
  // repeated in the notice; a success clears any older notice.
  async function save(patch: BookingPatch) {
    onUpdated(await updateBooking(booking.id, patch));
    setNotice(null);
  }

  // For the controls that act on click or change.
  async function run(action: () => Promise<Booking>) {
    setBusy(true);
    try {
      onUpdated(await action());
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const who = booking.customerName;
  const date = booking.eventDate.slice(0, 10);
  const cancelled = booking.status === "Cancelled";
  const held = booking.unitIds.map((id) => units.find((u) => u.id === id)).filter((u): u is Unit => !!u);
  const heldItems = [...new Set(held.map((u) => u.itemId))]
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is Item => !!i);
  const trackedItems = items.filter((item) => units.some((u) => u.itemId === item.id));
  // Choices whose item is no longer on the booking's unit list at all (the
  // item was deleted, say) still get shown.
  const looseAddons = booking.addons.filter((a) => !heldItems.some((i) => i.id === a.itemId));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Booking for ${who}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            {who}
            <span className={cancelled ? "status-pill booking-pill" : "status-pill status-pill-live booking-pill"}>
              {booking.status}
            </span>
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {notice && (
          <p className="form-error booking-notice" role="alert">
            {notice}
          </p>
        )}

        <div className="catalog-detail">
          <div className="detail-field">
            <span className="detail-field-label">Event date</span>
            <EditableCell type="date" value={date} ariaLabel={`Event date for ${who}`} onSave={(eventDate) => save({ eventDate })} />
          </div>
          <div className="detail-field">
            <span className="detail-field-label">Time</span>
            <EditableCell
              value={booking.eventTime ?? ""}
              placeholder="Add time"
              ariaLabel={`Event time for ${who}`}
              onSave={(eventTime) => save({ eventTime: eventTime === "" ? null : eventTime })}
            />
          </div>
          <div className="detail-field">
            <span className="detail-field-label">Customer name</span>
            <EditableCell value={who} ariaLabel={`Customer name for ${who}`} onSave={(customerName) => save({ customerName })} />
          </div>
          <div className="detail-field">
            <span className="detail-field-label">Phone</span>
            <EditableCell
              value={booking.phone ?? ""}
              placeholder="Add phone"
              ariaLabel={`Phone for ${who}`}
              onSave={(phone) => save({ phone })}
            />
          </div>
          <div className="detail-field">
            <span className="detail-field-label">Email</span>
            <EditableCell
              value={booking.email ?? ""}
              placeholder="Add email"
              ariaLabel={`Email for ${who}`}
              onSave={(email) => save({ email })}
            />
          </div>
          <div className="detail-field">
            <span className="detail-field-label">Address</span>
            <EditableCell
              value={booking.address ?? ""}
              placeholder="Add address"
              ariaLabel={`Address for ${who}`}
              onSave={(address) => save({ address: address === "" ? null : address })}
            />
          </div>
          <label className="detail-field">
            <span className="detail-field-label">Status</span>
            <select
              value={booking.status}
              disabled={busy}
              aria-label={`Status for ${who}`}
              onChange={(e) => run(() => updateBooking(booking.id, { status: e.target.value as BookingStatus }))}
            >
              {BOOKING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="detail-field">
            <span className="detail-field-label">Lead</span>
            <select
              value={booking.leadId ?? ""}
              disabled={busy}
              aria-label={`Lead for ${who}`}
              onChange={(e) => run(() => updateBooking(booking.id, { leadId: e.target.value === "" ? null : e.target.value }))}
            >
              <option value="">No lead</option>
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {leadLabel(lead)}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={booking.depositPaid}
              disabled={busy}
              onChange={(e) => run(() => updateBooking(booking.id, { depositPaid: e.target.checked }))}
            />
            Deposit paid
          </label>
          <div className="booking-quote">
            {booking.total !== null ? (
              <>
                <span className="detail-field-label">Quoted</span> <strong>{usd(Number(booking.total))}</strong>
              </>
            ) : (
              <span className="muted">No quoted total on this booking.</span>
            )}
          </div>
        </div>

        <div className="modal-section">
          <span className="detail-field-label">Items and units</span>
          {cancelled && <p className="muted">A cancelled booking holds no units. Set it back to Confirmed to add some.</p>}
          {!cancelled && heldItems.length === 0 && <p className="muted">No units on this booking yet.</p>}

          {heldItems.map((item) => (
            <BookingItemCard
              key={item.id}
              item={item}
              units={held.filter((u) => u.itemId === item.id)}
              addons={booking.addons.filter((a) => a.itemId === item.id)}
              busy={busy}
              onRemoveUnit={(unitId) => run(() => removeBookingUnit(booking.id, unitId))}
              onSetAddons={(addonIds) => run(() => setBookingAddons(booking.id, item.id, addonIds))}
            />
          ))}

          {looseAddons.length > 0 && (
            <ul className="booking-addons">
              {looseAddons.map((addon) => (
                <li key={addon.id}>
                  <span className="muted">{addon.itemName}</span> {describeAddon(addon)}
                </li>
              ))}
            </ul>
          )}

          {!cancelled && (
            <form
              className="booking-add-item"
              onSubmit={(e) => {
                e.preventDefault();
                if (addItemId === "") return;
                run(() => addBookingUnit(booking.id, addItemId));
              }}
            >
              <select value={addItemId} onChange={(e) => setAddItemId(e.target.value)} disabled={busy} aria-label="Item to add">
                <option value="">Add an item for this date…</option>
                {trackedItems.map((item) => {
                  const free = freeCount(item, date, units, bookings);
                  return (
                    <option key={item.id} value={item.id} disabled={free === 0}>
                      {item.name} · {free === 0 ? "none free" : `${free} free`}
                    </option>
                  );
                })}
              </select>
              <button type="submit" className="btn-secondary" disabled={busy || addItemId === ""}>
                Add a unit
              </button>
            </form>
          )}
          <p className="muted booking-help">
            Changing the date moves every item to a unit that's free on the new day, or changes nothing if one of them has
            none. Adding an item takes whichever of its units is free on this date.
          </p>
        </div>

        <div className="modal-foot">
          <span className="muted">Changes save as you go.</span>
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function BookingItemCard({
  item,
  units,
  addons,
  busy,
  onRemoveUnit,
  onSetAddons,
}: {
  item: Item;
  units: Unit[];
  addons: BookingAddon[];
  busy: boolean;
  onRemoveUnit: (unitId: string) => void;
  onSetAddons: (addonIds: string[]) => void;
}) {
  const liveIds = new Set(item.addonGroups.flatMap((g) => g.addons.map((a) => a.id)));
  const chosenIn = (group: AddonGroup) => addons.find((a) => a.addonId && group.addons.some((o) => o.id === a.addonId));
  // Chosen when booked, but the option has since been removed from the
  // item. Kept as the record; it can't be picked again.
  const retired = addons.filter((a) => !a.addonId || !liveIds.has(a.addonId));

  function pick(group: AddonGroup, addonId: string) {
    const others = item.addonGroups
      .filter((g) => g.id !== group.id)
      .map((g) => chosenIn(g)?.addonId)
      .filter((id): id is string => !!id);
    onSetAddons(addonId === "" ? others : [...others, addonId]);
  }

  return (
    <div className="addon-group booking-item">
      <div className="booking-item-head">
        <strong>{item.name}</strong>
        <span className="muted">{item.price !== null ? usd(Number(item.price)) : "TBD"}</span>
      </div>
      <div className="booking-units">
        {units.map((unit) => (
          <span key={unit.id} className="tag-chip">
            {unit.label}
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove ${item.name} ${unit.label} from this booking`}
              disabled={busy}
              onClick={() => onRemoveUnit(unit.id)}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>

      {item.addonGroups.length > 0 && (
        <div className="booking-item-addons">
          {item.addonGroups.map((group) => {
            const chosen = chosenIn(group);
            return (
              <label key={group.id}>
                <span className="booking-addon-label">
                  {group.name}
                  {group.required && !chosen && <span className="booking-addon-missing"> · required, not chosen</span>}
                </span>
                <select
                  value={chosen?.addonId ?? ""}
                  disabled={busy || group.addons.length === 0}
                  aria-label={`${group.name} for ${item.name}`}
                  onChange={(e) => pick(group, e.target.value)}
                >
                  <option value="">None</option>
                  {group.addons.map((option) => {
                    const delta = deltaLabel(option.priceDelta);
                    return (
                      <option key={option.id} value={option.id}>
                        {option.name}
                        {delta ? ` (${delta})` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            );
          })}
        </div>
      )}

      {retired.length > 0 && (
        <ul className="booking-addons">
          {retired.map((addon) => (
            <li key={addon.id}>
              {describeAddon(addon)} <span className="muted">· chosen at booking, no longer offered</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
