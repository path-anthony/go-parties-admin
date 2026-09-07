import { useEffect, useState } from "react";
import { getItems } from "../lib/api";
import type { Item } from "../lib/types";
import { AddItemForm } from "./AddItemForm";

function formatPrice(item: Item) {
  if (!item.price) return "TBD";
  const amount = Number(item.price).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return item.priceUnit ? `${amount} · ${item.priceUnit}` : amount;
}

export function ItemsPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getItems()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load items"));
  }, []);

  const byCategory = new Map<string, Item[]>();
  for (const item of items ?? []) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  return (
    <div className="page">
      <section className="panel">
        <h2>Add an item</h2>
        <AddItemForm onAdded={(item) => setItems((prev) => [...(prev ?? []), item])} />
      </section>

      <section className="panel">
        <h2>Catalog{items ? ` (${items.length})` : ""}</h2>
        {error && <p className="form-error">{error}</p>}
        {!items && !error && <p className="muted">Loading…</p>}
        {items && items.length === 0 && <p className="muted">No items yet.</p>}
        {[...byCategory.entries()].map(([category, catItems]) => (
          <div key={category} className="category-group">
            <h3 className="category-label">{category}</h3>
            <ul className="item-list">
              {catItems.map((item) => (
                <li key={item.id} className="item-row">
                  <span className="item-name">{item.name}</span>
                  <span className="item-price">{formatPrice(item)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
