import { type FormEvent, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { createUnitsBulk, getItems, getUnits } from "../../lib/api";
import { UNIT_STATUSES, type Item, type ItemDeleteResult, type Unit, type UnitStatus } from "../../lib/types";
import { ItemModal } from "../ItemModal";
import { ItemsTable } from "../ItemsTable";
import { StatCard, StatGrid } from "../StatCard";

const ALL_CATEGORIES = "";

function matches(item: Item, query: string, category: string): boolean {
  if (category !== ALL_CATEGORIES && item.category !== category) return false;
  if (query === "") return true;
  return item.name.toLowerCase().includes(query) || (item.notes ?? "").toLowerCase().includes(query);
}

const names = (rows: { name: string }[]) => rows.map((row) => row.name).join(", ");

// One plain sentence about what a delete did, for the line above the list.
function describeDelete(item: Item, result: ItemDeleteResult): string {
  const parts = [`Deleted ${item.name}.`];
  if (result.removedFrom.length > 0) {
    parts.push(
      `Removed it from ${result.removedFrom.length === 1 ? "the package" : "packages"} ${names(result.removedFrom)}.`,
    );
  }
  if (result.unpublished.length > 0) {
    parts.push(
      `${names(result.unpublished)} ${result.unpublished.length === 1 ? "was" : "were"} left with no items and ` +
        `${result.unpublished.length === 1 ? "is" : "are"} now unpublished, kept as a draft.`,
    );
  }
  return parts.join(" ");
}

export function InventoryScreen() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The item popup: a new item, or an existing one by id (looked up in
  // items on each render, so saves inside the popup show up in it).
  const [modal, setModal] = useState<{ mode: "create" } | { mode: "edit"; id: string } | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  // One line about the last bulk add or delete, shown above the list.
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getItems(), getUnits()])
      .then(([itemList, unitList]) => {
        setItems(itemList);
        setUnits(unitList);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load items"));
  }, []);

  function handleItemUpdated(updated: Item) {
    setItems((prev) => (prev ?? []).map((item) => (item.id === updated.id ? updated : item)));
  }

  // The item is gone from the server; drop it here too, along with its
  // units and any selection of it, close the popup, and say what happened.
  function handleItemDeleted(item: Item, result: ItemDeleteResult) {
    setItems((prev) => (prev ?? []).filter((row) => row.id !== item.id));
    setUnits((prev) => prev.filter((unit) => unit.itemId !== item.id));
    setSelected((prev) => {
      if (!prev.has(item.id)) return prev;
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    setModal(null);
    setNotice(describeDelete(item, result));
  }

  function toggleSelect(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function selectAll(ids: string[], checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  // A new item goes to the top of the list so it's visible without
  // scrolling (it settles into category order on the next load), and the
  // popup stays open on it, now in edit mode, ready for its add-ons.
  // Filters are cleared so the new row can't be hidden by them.
  function handleAdded(item: Item) {
    setItems((prev) => [item, ...(prev ?? [])]);
    setModal({ mode: "edit", id: item.id });
    setSearch("");
    setCategory(ALL_CATEGORIES);
    // The item may have been created with starting units; pick them up so
    // the row's count and the popup's Units section are right.
    getUnits().then(setUnits).catch(() => undefined);
  }

  async function handleBulkCreated(created: number, itemCount: number) {
    setUnits(await getUnits());
    setNotice(`Created ${created} ${created === 1 ? "unit" : "units"} across ${itemCount} ${itemCount === 1 ? "item" : "items"}.`);
    setSelected(new Set());
    setBulkOpen(false);
  }

  const query = search.trim().toLowerCase();
  const filtering = query !== "" || category !== ALL_CATEGORIES;
  const categories = items ? [...new Set(items.map((item) => item.category))].sort((a, b) => a.localeCompare(b)) : [];
  const visible = items ? items.filter((item) => matches(item, query, category)) : [];
  const modalItem = modal?.mode === "edit" ? items?.find((item) => item.id === modal.id) : undefined;
  const unitCounts = new Map<string, number>();
  for (const unit of units) unitCounts.set(unit.itemId, (unitCounts.get(unit.itemId) ?? 0) + 1);

  return (
    <div className="screen">
      <section className="panel">
        <div className="panel-header-row inventory-head">
          <h2>Catalog{items ? ` (${items.length})` : ""}</h2>
          <div className="inventory-actions">
            <a className="btn-secondary" href="/api/items/export.csv" download="items-export.csv">
              Export CSV
            </a>
            <button type="button" className="btn-primary btn-add-item" onClick={() => setModal({ mode: "create" })}>
              <Plus size={18} strokeWidth={2.75} />
              Add an item
            </button>
          </div>
        </div>

        {items && (
          <StatGrid className="kpi-grid-strip">
            <StatCard label="Total items" value={items.length} />
            <StatCard label="Priced" value={items.filter((item) => item.price !== null).length} />
            <StatCard label="TBD / no price" value={items.filter((item) => item.price === null).length} />
            <StatCard label="Categories" value={categories.length} />
          </StatGrid>
        )}

        {items && items.length > 0 && (
          <div className="filter-row">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or notes"
              aria-label="Search items by name or notes"
            />
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
              <option value={ALL_CATEGORIES}>All categories</option>
              {categories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {filtering && (
              <>
                <span className="filter-count">
                  {visible.length} of {items.length} items
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setSearch("");
                    setCategory(ALL_CATEGORIES);
                  }}
                >
                  Clear
                </button>
              </>
            )}
            {selected.size > 0 && (
              <div className="bulk-actions">
                <span className="filter-count">{selected.size} selected</span>
                <button type="button" className="btn-primary" onClick={() => setBulkOpen(true)} disabled={bulkOpen}>
                  Add units
                </button>
                <button type="button" className="btn-secondary" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
              </div>
            )}
          </div>
        )}

        {bulkOpen && selected.size > 0 && (
          <BulkUnitsForm
            itemIds={[...selected]}
            onCreated={handleBulkCreated}
            onCancel={() => setBulkOpen(false)}
          />
        )}
        {notice && (
          <p className="bulk-result" role="status">
            {notice}
          </p>
        )}

        {error && <p className="form-error">{error}</p>}
        {!items && !error && <p className="muted">Loading…</p>}
        {items && items.length === 0 && <p className="muted">No items yet.</p>}
        {items && items.length > 0 && visible.length === 0 && <p className="muted">No items match.</p>}
        {visible.length > 0 && (
          <ItemsTable
            items={visible}
            onOpen={(id) => setModal({ mode: "edit", id })}
            selected={selected}
            onToggleSelect={toggleSelect}
            onSelectAll={selectAll}
            unitCounts={unitCounts}
          />
        )}
      </section>

      {modal && (modal.mode === "create" || modalItem) && (
        <ItemModal
          item={modal.mode === "edit" ? (modalItem ?? null) : null}
          units={modalItem ? units.filter((unit) => unit.itemId === modalItem.id) : []}
          categories={categories}
          onClose={() => setModal(null)}
          onCreated={handleAdded}
          onItemUpdated={handleItemUpdated}
          onUnitsAdded={async () => setUnits(await getUnits())}
          onUnitRemoved={(unitId) => setUnits((prev) => prev.filter((unit) => unit.id !== unitId))}
          onDeleted={handleItemDeleted}
        />
      )}
    </div>
  );
}

// The same units, in the same count, for every selected item, in one call.
function BulkUnitsForm({
  itemIds,
  onCreated,
  onCancel,
}: {
  itemIds: string[];
  onCreated: (created: number, itemCount: number) => Promise<void>;
  onCancel: () => void;
}) {
  const [labelPattern, setLabelPattern] = useState("Unit #1");
  const [quantity, setQuantity] = useState(1);
  const [status, setStatus] = useState<UnitStatus>("Available");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await createUnitsBulk({ itemIds, labelPattern, quantity, status });
      await onCreated(result.created, result.items.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add units");
    } finally {
      setSaving(false);
    }
  }

  const total = quantity * itemIds.length;

  return (
    <form className="bulk-form" onSubmit={handleSubmit}>
      <div className="inline-form">
        <label>
          Label pattern
          <input value={labelPattern} onChange={(e) => setLabelPattern(e.target.value)} placeholder="e.g. Cart #1" required />
        </label>
        <label>
          Units per item
          <input
            type="number"
            min={1}
            max={50}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
            required
          />
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as UnitStatus)}>
            {UNIT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Creating…" : `Create ${total} ${total === 1 ? "unit" : "units"}`}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
      <p className="muted bulk-help">
        {quantity} {quantity === 1 ? "unit" : "units"} for each of the {itemIds.length} selected{" "}
        {itemIds.length === 1 ? "item" : "items"}, numbered from the pattern. Numbers an item already uses are
        skipped.
      </p>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}
