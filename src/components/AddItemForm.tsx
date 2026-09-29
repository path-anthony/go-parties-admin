import { type FormEvent, useState } from "react";
import { createItem } from "../lib/api";
import { isUploadedPhoto } from "../lib/photo";
import { ITEM_SOURCES, type ItemSource } from "../lib/itemFields";
import type { Skill } from "../lib/skills";
import type { Item, NewItem } from "../lib/types";
import { BilledPerPicker } from "./BilledPerPicker";
import { CategoryPicker } from "./CategoryPicker";
import { PhotoDropZone } from "./PhotoDropZone";

const EMPTY: NewItem = {
  name: "",
  category: "",
  price: "",
  priceUnit: "",
  source: "Owned",
  needsPriceReview: false,
  notes: "",
  photoUrl: "",
  skills: [],
  startingUnits: 1,
};

export function AddItemForm({
  categories,
  skillNames,
  onAdded,
  onCancel,
}: {
  // Every category in use across the catalog, the picker's options.
  categories: string[];
  // The skill names from Settings.
  skillNames: string[];
  onAdded: (item: Item) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<NewItem>(EMPTY);
  // Categories added through "+ Add new category" this session, so they
  // are offered again before the catalog reload makes them real.
  const [added, setAdded] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof NewItem>(key: K, value: NewItem[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleSkill(skill: Skill, on: boolean) {
    set("skills", on ? [...new Set([...form.skills, skill])] : form.skills.filter((s) => s !== skill));
  }

  const options = [...new Set([...categories, ...added])].sort((a, b) => a.localeCompare(b));
  const service = form.skills.length > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!options.includes(form.category)) {
      setError("Pick a category from the list, or add a new one with the + option.");
      return;
    }
    setSaving(true);
    try {
      const item = await createItem({ ...form, startingUnits: service ? 0 : form.startingUnits });
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
        <CategoryPicker
          options={options}
          value={form.category}
          onChange={(category) => set("category", category)}
          onAddNew={(category) => {
            setAdded((prev) => (prev.includes(category) ? prev : [...prev, category]));
            set("category", category);
          }}
        />
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
        <BilledPerPicker
          value={form.priceUnit}
          onSelect={(value) => set("priceUnit", value)}
          onText={(value) => set("priceUnit", value)}
          disabled={saving}
          ariaLabel="Billed per"
        />
      </div>
      <div className="field-row">
        <label>
          Source
          <select value={form.source} onChange={(e) => set("source", e.target.value as ItemSource)} disabled={saving}>
            {ITEM_SOURCES.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
          <span className="muted field-help">Admin only. Customers never see it.</span>
        </label>
        <label className="checkbox-label review-check">
          <input type="checkbox" checked={form.needsPriceReview} onChange={(e) => set("needsPriceReview", e.target.checked)} disabled={saving} />
          Needs price review
          <span className="muted field-help">Admin only. Flags a price that still needs a look.</span>
        </label>
      </div>

      <div className="detail-field">
        <span className="detail-field-label">Crew skills needed</span>
        <div className="skill-grid" role="group" aria-label="Crew skills needed">
          {skillNames.length === 0 && <span className="muted">No skills yet. Add them under Settings.</span>}
          {skillNames.map((skill) => (
            <label key={skill} className="checkbox-label">
              <input type="checkbox" checked={form.skills.includes(skill)} onChange={(e) => toggleSkill(skill, e.target.checked)} disabled={saving} />
              {skill}
            </label>
          ))}
        </div>
        <span className="muted field-help">Every person this item needs to run, one gig each when it's booked. Leave all unchecked for a physical item.</span>
      </div>

      <div className="field-row">
        <label className={service ? "field-muted" : ""}>
          Starting units
          <input
            type="number"
            min={0}
            max={50}
            step={1}
            value={service ? 0 : form.startingUnits}
            onChange={(e) => set("startingUnits", Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
            disabled={saving || service}
            aria-label="Starting units"
          />
          <span className="muted field-help">
            {service
              ? "A service item is covered by crew, so it gets no units."
              : "How many real pieces exist today. Each becomes a unit, labelled Unit #1, #2, and so on."}
          </span>
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
