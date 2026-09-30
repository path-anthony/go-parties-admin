import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  createUnit,
  getBookings,
  getItems,
  getLeads,
  getUnits,
  updateUnit,
} from "../../lib/api";
import {
  UNIT_STATUSES,
  type Booking,
  type Item,
  type Lead,
  type NewUnit,
  type Unit,
  type UnitPatch,
  type UnitStatus,
} from "../../lib/types";
import { BookingModal } from "../BookingModal";
import { AgreementChip, BalanceLabel } from "../AgreementChip";
import { BookingStatusTag } from "../BookingStatusTag";
import { NewBookingModal } from "../NewBookingModal";
import { EditableCell } from "../EditableCell";
import { RushTag } from "../RushTag";

type ItemsById = Map<string, Item>;

function itemLabel(item: Item | undefined): string {
  return item ? `${item.name} · ${item.category}` : "Unknown item";
}

function sortItems(items: Item[]): Item[] {
  return [...items].sort(
    (a, b) =>
      a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
}

function sortUnits(units: Unit[], itemsById: ItemsById): Unit[] {
  return [...units].sort(
    (a, b) =>
      (itemsById.get(a.itemId)?.name ?? "").localeCompare(
        itemsById.get(b.itemId)?.name ?? "",
      ) || a.label.localeCompare(b.label),
  );
}

function sortBookings(bookings: Booking[]): Booking[] {
  return [...bookings].sort(
    (a, b) =>
      a.eventDate.localeCompare(b.eventDate) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

// One screen, two pages under Scheduling in the sidebar: Bookings and
// Inventory status. They share their data, so both routes render this with
// a view; there are no in-page tabs.
export function SchedulingScreen({ view = "bookings" }: { view?: "bookings" | "units" } = {}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The booking popup, by id: looked up in bookings on each render so a
  // save inside the popup shows in it and in the row behind it.
  const [openId, setOpenId] = useState<string | null>(null);
  // Bookings are the daily view; the units have their own page,
  // searchable, since there are hundreds of them.
  const tab = view;
  const [unitSearch, setUnitSearch] = useState("");
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    Promise.all([getItems(), getUnits(), getBookings(), getLeads()])
      .then(([itemList, unitList, bookingList, leadList]) => {
        setItems(sortItems(itemList));
        setUnits(unitList);
        setBookings(bookingList);
        setLeads(leadList);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, []);

  const openBooking = openId
    ? (bookings ?? []).find((b) => b.id === openId)
    : undefined;
  const ready =
    items !== null && units !== null && bookings !== null && leads !== null;
  const itemsById: ItemsById = new Map(
    (items ?? []).map((item) => [item.id, item]),
  );
  const unitQuery = unitSearch.trim().toLowerCase();
  const visibleUnits = (units ?? []).filter(
    (unit) =>
      unitQuery === "" ||
      (itemsById.get(unit.itemId)?.name ?? "")
        .toLowerCase()
        .includes(unitQuery) ||
      unit.label.toLowerCase().includes(unitQuery),
  );
  const unitStatusCounts = new Map<string, number>();
  for (const unit of units ?? [])
    unitStatusCounts.set(
      unit.status,
      (unitStatusCounts.get(unit.status) ?? 0) + 1,
    );

  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>{view === "units" ? "Inventory status" : "Bookings"}</h2>
        <p className="muted">
          {view === "units"
            ? "Every physical unit and its manual status."
            : "Bookings by date, with their status, and behind them the physical units each item has. No calendar yet."}
          {ready && ` ${view === "units" ? `${units.length} units.` : `${bookings.length} bookings.`}`}
        </p>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!ready && !error && <p className="muted">Loading…</p>}

      {ready && (
        <>
          <section className="panel">
            {tab === "units" && (
              <>
                <p className="muted">
                  Every physical unit, one row each, with its manual status.{" "}
                  {UNIT_STATUSES.map(
                    (s) => `${unitStatusCounts.get(s) ?? 0} ${s.toLowerCase()}`,
                  ).join(", ")}
                  . Availability by date comes from bookings, not from this
                  status.
                </p>
                <AddUnitForm
                  items={items}
                  onAdded={(unit) =>
                    setUnits((prev) =>
                      sortUnits([...(prev ?? []), unit], itemsById),
                    )
                  }
                />
                <div className="filter-row">
                  <input
                    type="search"
                    value={unitSearch}
                    onChange={(e) => setUnitSearch(e.target.value)}
                    placeholder="Search by item or label"
                    aria-label="Search units by item or label"
                  />
                  {unitQuery !== "" && (
                    <span className="filter-count">
                      {visibleUnits.length} of {units.length} units
                    </span>
                  )}
                </div>
                {units.length === 0 ? (
                  <p className="muted">Nothing here yet.</p>
                ) : visibleUnits.length === 0 ? (
                  <p className="muted">No units match.</p>
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
                        {visibleUnits.map((unit) => (
                          <UnitRow
                            key={unit.id}
                            unit={unit}
                            item={itemsById.get(unit.itemId)}
                            onUpdated={(updated) =>
                              setUnits((prev) =>
                                (prev ?? []).map((u) =>
                                  u.id === updated.id ? updated : u,
                                ),
                              )
                            }
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {tab === "bookings" && (
              <>
                <div className="scheduling-actions">
                  <button type="button" className="btn-primary" onClick={() => setNewOpen(true)}>
                    New booking
                  </button>
                  <span className="muted">For a customer booking by phone or in person. Same availability and locks as the storefront.</span>
                </div>
                {bookings.length === 0 ? (
                  <p className="muted">Nothing here yet.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="items-table scheduling-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Time</th>
                          <th>Customer</th>
                          <th>Status</th>
                          <th>Agreement</th>
                          <th>Items</th>
                          <th aria-label="Open" />
                        </tr>
                      </thead>
                      <tbody>
                        {bookings.map((booking) => (
                          <BookingSummaryRow
                            key={booking.id}
                            booking={booking}
                            units={units}
                            itemsById={itemsById}
                            onOpen={() => setOpenId(booking.id)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>

          {newOpen && (
            <NewBookingModal
              onClose={() => setNewOpen(false)}
              onCreated={async (bookingId) => {
                // Reload what it touched: the booking, the units it now holds, and
                // the lead it created.
                const [bookingList, unitList, leadList] = await Promise.all([getBookings(), getUnits(), getLeads()]);
                setBookings(sortBookings(bookingList));
                setUnits(unitList);
                setLeads(leadList);
                setNewOpen(false);
                setOpenId(bookingId);
              }}
            />
          )}

          {openBooking && (
            <BookingModal
              booking={openBooking}
              leads={leads}
              units={units}
              items={items}
              bookings={bookings}
              onUpdated={(updated) =>
                setBookings((prev) =>
                  sortBookings(
                    (prev ?? []).map((b) =>
                      b.id === updated.id ? updated : b,
                    ),
                  ),
                )
              }
              onClose={() => setOpenId(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

function formatDay(eventDate: string): string {
  return new Date(eventDate).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// One line per booking. Everything else, and all editing, is in the popup.
function BookingSummaryRow({
  booking,
  units,
  itemsById,
  onOpen,
}: {
  booking: Booking;
  units: Unit[];
  itemsById: ItemsById;
  onOpen: () => void;
}) {
  const held = booking.unitIds
    .map((id) => units.find((u) => u.id === id))
    .filter((u): u is Unit => !!u);
  const liveGigs = booking.gigs.filter((g) => g.status !== "Cancelled");
  const names = [
    ...new Set([
      ...held.map((u) => itemsById.get(u.itemId)?.name ?? "Unknown item"),
      ...liveGigs.map((g) => g.itemName),
    ]),
  ];
  const count = held.length + liveGigs.length;

  function handleKey(e: KeyboardEvent<HTMLTableRowElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  }

  return (
    <tr
      className="catalog-row"
      onClick={onOpen}
      onKeyDown={handleKey}
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={`Open the booking for ${booking.customerName} on ${formatDay(booking.eventDate)}`}
    >
      <td className="booking-date">{formatDay(booking.eventDate)}</td>
      <td className={booking.eventTime ? "booking-time" : "booking-time muted"}>
        {booking.eventTime ?? "No time"}
      </td>
      <td className="catalog-name">
        {booking.customerName}
        <RushTag rush={booking.rush} cancelled={booking.status === "Cancelled"} />
      </td>
      <td>
        <BookingStatusTag booking={booking} />
      </td>
      <td>
        <AgreementChip agreement={booking.agreement} />
        <div>
          <BalanceLabel preference={booking.balancePaymentPreference} />
        </div>
      </td>
      <td className={count === 0 ? "muted" : ""}>
        {count === 0 ? "None" : `${count} ${count === 1 ? "item" : "items"}`}
        {names.length > 0 && (
          <span className="muted booking-item-names">
            {" "}
            · {names.join(", ")}
          </span>
        )}
        {booking.addons.length > 0 && (
          <span className="muted booking-item-names">
            {" "}
            · {booking.addons.length}{" "}
            {booking.addons.length === 1 ? "add-on" : "add-ons"}
          </span>
        )}
      </td>
      <td className="catalog-chevron">
        <ChevronRight size={14} />
      </td>
    </tr>
  );
}

function AddUnitForm({
  items,
  onAdded,
}: {
  items: Item[];
  onAdded: (unit: Unit) => void;
}) {
  const [form, setForm] = useState<NewUnit>({
    itemId: items[0]?.id ?? "",
    label: "",
    status: "Available",
  });
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
        <select
          value={form.itemId}
          onChange={(e) => setForm((f) => ({ ...f, itemId: e.target.value }))}
          required
        >
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
        <select
          value={form.status}
          onChange={(e) =>
            setForm((f) => ({ ...f, status: e.target.value as UnitStatus }))
          }
        >
          {UNIT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="btn-primary"
        disabled={saving || items.length === 0}
      >
        {saving ? "Adding…" : "Add unit"}
      </button>
      {error && <p className="form-error inline-form-wide">{error}</p>}
    </form>
  );
}

function UnitRow({
  unit,
  item,
  onUpdated,
}: {
  unit: Unit;
  item: Item | undefined;
  onUpdated: (unit: Unit) => void;
}) {
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
        <EditableCell
          value={unit.label}
          ariaLabel={`Label for ${unit.label}`}
          onSave={(label) => save({ label })}
        />
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
