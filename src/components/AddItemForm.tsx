import { type FormEvent, useState } from "react";
import { createItem } from "../lib/api";
import type { Item, NewItem } from "../lib/types";

const EMPTY: NewItem = { name: "", category: "", price: "", priceUnit: "", notes: "", photoUrl: "" };

export function AddItemForm({ onAdded }: { onAdded: (item: Item) => void }) {
  const [form, setForm] = useState<NewItem>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof NewItem>(key: K, value: NewItem[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const item = await createItem(form);
      onAdded(item);
      setForm(EMPTY);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add item");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="add-item-form">
      <div className="field-row">
        <label>
          Name*
          <input value={form.name} onChange={(e) => set("name", e.target.value)} required />
        </label>
        <label>
          Category*
          <input value={form.category} onChange={(e) => set("category", e.target.value)} required />
        </label>
      </div>
      <div className="field-row">
        <label>
          Price
          <input
            type="number"
            step="0.01"
            value={form.price}
            onChange={(e) => set("price", e.target.value)}
            placeholder="e.g. 475"
          />
        </label>
        <label>
          Price unit
          <input
            value={form.priceUnit}
            onChange={(e) => set("priceUnit", e.target.value)}
            placeholder="e.g. per day"
          />
        </label>
      </div>
      <label>
        Notes
        <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <label>
        Photo URL
        <input value={form.photoUrl} onChange={(e) => set("photoUrl", e.target.value)} placeholder="https://..." />
      </label>
      {error && <p className="form-error">{error}</p>}
      <button type="submit" className="btn-primary" disabled={saving}>
        {saving ? "Adding…" : "Add item"}
      </button>
    </form>
  );
}
