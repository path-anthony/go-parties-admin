import { type FormEvent, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { createUnitsBulk, getItems, getUnits } from "../../lib/api";
import { UNIT_STATUSES, type Item, type Unit, type UnitStatus } from "../../lib/types";
import { AddItemForm } from "../AddItemForm";
import { ItemsTable } from "../ItemsTable";

const ALL_CATEGORIES = "";

function matches(item: Item, query: string, category: string): boolean {
  if (category !== ALL_CATEGORIES && item.category !== category) return false;
  if (query === "") return true;
  return item.name.toLowerCase().includes(query) || (item.notes ?? "").toLowerCase().includes(query);
}

export function InventoryScreen() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

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

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  // A new item goes to the top, expanded, so it's visible without scrolling
  // and ready for a photo. It settles into category order on the next load.
  // Filters are cleared so the new row can't be hidden by them.
  function handleAdded(item: Item) {
    setItems((prev) => [item, ...(prev ?? [])]);
    setExpanded((prev) => new Set(prev).add(item.id));
    setQuickAddOpen(false);
    setSearch("");
    setCategory(ALL_CATEGORIES);
  }

  async function handleBulkCreated(created: number, itemCount: number) {
    setUnits(await getUnits());
    setBulkResult(`Created ${created} ${created === 1 ? "unit" : "units"} across ${itemCount} ${itemCount === 1 ? "item" : "items"}.`);
    setSelected(new Set());
    setBulkOpen(false);
  }

  const query = search.trim().toLowerCase();
  const filtering = query !== "" || category !== ALL_CATEGORIES;
  const categories = items ? [...new Set(items.map((item) => item.category))].sort((a, b) => a.localeCompare(b)) : [];
  const visible = items ? items.filter((item) => matches(item, query, category)) : [];
  const unitCounts = new Map<string, number>();
  for (const unit of units) unitCounts.set(unit.itemId, (unitCounts.get(unit.itemId) ?? 0) + 1);

  return (
    <div className="screen">
      <section className="panel">
        <div className="panel-header-row">
          <h2>Catalog{items ? ` (${items.length})` : ""}</h2>
          <a className="btn-secondary" href="/api/items/export.csv" download="items-export.csv">
            Export CSV
          </a>
        </div>

        <div className="quick-add">
          {quickAddOpen ? (
            <div className="quick-add-form">
              <AddItemForm onAdded={handleAdded} onCancel={() => setQuickAddOpen(false)} />
            </div>
          ) : (
            <button type="button" className="quick-add-toggle" onClick={() => setQuickAddOpen(true)}>
              <Plus size={14} />
              Add an item
            </button>
          )}
        </div>

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
        {bulkResult && <p className="bulk-result">{bulkResult}</p>}

        {error && <p className="form-error">{error}</p>}
        {!items && !error && <p className="muted">Loading…</p>}
        {items && items.length === 0 && <p className="muted">No items yet.</p>}
        {items && items.length > 0 && visible.length === 0 && <p className="muted">No items match.</p>}
        {visible.length > 0 && (
          <ItemsTable
            items={visible}
            expanded={expanded}
            onToggle={toggle}
            onItemUpdated={handleItemUpdated}
            selected={selected}
            onToggleSelect={toggleSelect}
            onSelectAll={selectAll}
            unitCounts={unitCounts}
          />
        )}
      </section>
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
