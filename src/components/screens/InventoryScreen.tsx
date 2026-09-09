import { useEffect, useState } from "react";
import { getItems } from "../../lib/api";
import type { Item } from "../../lib/types";
import { AddItemForm } from "../AddItemForm";
import { EditableItemsTable } from "../EditableItemsTable";

export function InventoryScreen() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getItems()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load items"));
  }, []);

  function handleItemUpdated(updated: Item) {
    setItems((prev) => (prev ?? []).map((item) => (item.id === updated.id ? updated : item)));
  }

  return (
    <div className="screen">
      <section className="panel">
        <h2>Add an item</h2>
        <AddItemForm onAdded={(item) => setItems((prev) => [...(prev ?? []), item])} />
      </section>

      <section className="panel">
        <div className="panel-header-row">
          <h2>Catalog{items ? ` (${items.length})` : ""}</h2>
          <a className="btn-secondary" href="/api/items/export.csv" download="items-export.csv">
            Export CSV
          </a>
        </div>
        {error && <p className="form-error">{error}</p>}
        {!items && !error && <p className="muted">Loading…</p>}
        {items && items.length === 0 && <p className="muted">No items yet.</p>}
        {items && items.length > 0 && <EditableItemsTable items={items} onItemUpdated={handleItemUpdated} />}
      </section>
    </div>
  );
}
