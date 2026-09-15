import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { getItems } from "../../lib/api";
import type { Item } from "../../lib/types";
import { AddItemForm } from "../AddItemForm";
import { ItemsTable } from "../ItemsTable";

export function InventoryScreen() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
  function handleAdded(item: Item) {
    setItems((prev) => [item, ...(prev ?? [])]);
    setExpanded((prev) => new Set(prev).add(item.id));
    setQuickAddOpen(false);
  }

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

        {error && <p className="form-error">{error}</p>}
        {!items && !error && <p className="muted">Loading…</p>}
        {items && items.length === 0 && <p className="muted">No items yet.</p>}
        {items && items.length > 0 && (
          <ItemsTable items={items} expanded={expanded} onToggle={toggle} onItemUpdated={handleItemUpdated} />
        )}
      </section>
    </div>
  );
}
