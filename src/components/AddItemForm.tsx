import { type FormEvent, useState } from "react";
import { createItem } from "../lib/api";
import { isUploadedPhoto } from "../lib/photo";
import type { Item, NewItem } from "../lib/types";
import { PhotoDropZone } from "./PhotoDropZone";

const EMPTY: NewItem = { name: "", category: "", price: "", priceUnit: "", notes: "", photoUrl: "" };

export function AddItemForm({ onAdded, onCancel }: { onAdded: (item: Item) => void; onCancel?: () => void }) {
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

  // A dropped photo is held in form state as a data URL and saved with the
  // item on submit, so a new item with a photo is one step, not two.
  const uploaded = isUploadedPhoto(form.photoUrl || null);

  return (
    <form onSubmit={handleSubmit} className="add-item-form">
      <div className="field-row">
        <label>
          Name*
          <input value={form.name} onChange={(e) => set("name", e.target.value)} required autoFocus />
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
          Billed per
          <input
            value={form.priceUnit}
            onChange={(e) => set("priceUnit", e.target.value)}
            placeholder="e.g. day, event, hour"
          />
        </label>
      </div>
      <label>
        Notes
        <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <div className="detail-field">
        <span className="detail-field-label">Photo</span>
        <PhotoDropZone
          value={form.photoUrl || null}
          alt="Photo for the new item"
          onPhoto={(photoUrl) => set("photoUrl", photoUrl)}
          disabled={saving}
          compact
        />
        <div className="photo-actions">
          {uploaded ? (
            <>
              <span className="muted">Photo attached. It saves with the item.</span>
              <button type="button" className="btn-secondary" onClick={() => set("photoUrl", "")} disabled={saving}>
                Remove photo
              </button>
            </>
          ) : (
            <input
              value={form.photoUrl}
              onChange={(e) => set("photoUrl", e.target.value)}
              placeholder="Or paste a photo URL, https://..."
              aria-label="Photo URL"
            />
          )}
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Adding…" : "Add item"}
        </button>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
