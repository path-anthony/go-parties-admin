import { type FormEvent, useEffect, useState } from "react";
import {
  createUnit,
  getBookings,
  getItems,
  getUnits,
  updateUnit,
} from "../../lib/api";
import {
  UNIT_STATUSES,
  type Booking,
  type Item,
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

// Inventory > Availability: every physical unit and its manual status. The
// bookings list that used to share this screen is BookingsScreen (Block F3b).
export function SchedulingScreen({ view = "units" }: { view?: "units" } = {}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tab = view;
  const [unitSearch, setUnitSearch] = useState("");

  useEffect(() => {
    Promise.all([getItems(), getUnits(), getBookings()])
      .then(([itemList, unitList, bookingList]) => {
        setItems(sortItems(itemList));
        setUnits(unitList);
        setBookings(bookingList);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, []);

  const ready =
    items !== null && units !== null && bookings !== null;
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
        <h2>{view === "units" ? "Availability" : "Bookings"}</h2>
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

          </section>

        </>
      )}
    </div>
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
