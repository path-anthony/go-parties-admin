import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { getItems } from "../../lib/api";
import type { Item } from "../../lib/types";
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
  const [error, setError] = useState<string | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);

  useEffect(() => {
    getItems()
      .then(setItems)
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

  const query = search.trim().toLowerCase();
  const filtering = query !== "" || category !== ALL_CATEGORIES;
  const categories = items ? [...new Set(items.map((item) => item.category))].sort((a, b) => a.localeCompare(b)) : [];
  const visible = items ? items.filter((item) => matches(item, query, category)) : [];

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
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
        {!items && !error && <p className="muted">Loading…</p>}
        {items && items.length === 0 && <p className="muted">No items yet.</p>}
        {items && items.length > 0 && visible.length === 0 && <p className="muted">No items match.</p>}
        {visible.length > 0 && (
          <ItemsTable items={visible} expanded={expanded} onToggle={toggle} onItemUpdated={handleItemUpdated} />
        )}
      </section>
    </div>
  );
}
