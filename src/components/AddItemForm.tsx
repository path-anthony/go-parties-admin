import { type FormEvent, useId, useState } from "react";
import { createItem } from "../lib/api";
import { isUploadedPhoto } from "../lib/photo";
import type { Skill } from "../lib/skills";
import type { Item, NewItem } from "../lib/types";
import { PhotoDropZone } from "./PhotoDropZone";

const EMPTY: NewItem = { name: "", category: "", price: "", priceUnit: "", notes: "", photoUrl: "", skills: [], startingUnits: 1 };

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
        <label>
          Billed per
          <input
            value={form.priceUnit}
            onChange={(e) => set("priceUnit", e.target.value)}
            placeholder="e.g. day, event, hour"
          />
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


// One combobox over the categories in use. Typing filters the list live;
// choosing a row sets the value. When nothing matches what was typed
// exactly (case-insensitively), the last row offers to create it, and
// choosing that row creates and applies it in one step. Free text on its
// own never becomes a category, and a name that matches an existing
// category in a different case reuses the existing one.
function CategoryPicker({
  options,
  value,
  onChange,
  onAddNew,
}: {
  options: string[];
  value: string;
  onChange: (category: string) => void;
  onAddNew: (category: string) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const typed = query.trim();
  const q = typed.toLowerCase();
  const matches = q === "" ? options : options.filter((c) => c.toLowerCase().includes(q));
  const exact = options.find((c) => c.toLowerCase() === q);
  const canCreate = typed !== "" && !exact;

  function choose(category: string) {
    onChange(category);
    setQuery("");
    setOpen(false);
  }

  function createTyped() {
    if (!canCreate) return;
    onAddNew(typed);
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="category-picker">
      <label>
        Category*
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          value={open ? query : value}
          placeholder={options.length === 0 ? "Type a category to create it" : "Pick from the list, or type to search"}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          // A click on a field already showing a chosen value starts a new
          // search (focus alone doesn't fire again while it stays focused).
          onClick={() => {
            if (!open) {
              setQuery("");
              setOpen(true);
            }
          }}
          onChange={(e) => {
            // Typing straight over a chosen value: the field held that value,
            // so the new text is the value plus what was typed. Keep only the
            // typed part as the search.
            const text = !open && value && e.target.value.startsWith(value) ? e.target.value.slice(value.length) : e.target.value;
            setQuery(text);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter") {
              e.preventDefault();
              // Enter takes the exact match, else the single remaining
              // match, else offers nothing: creating is the explicit row.
              if (exact) choose(exact);
              else if (matches.length === 1) choose(matches[0]);
            }
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          required={value === ""}
        />
      </label>
      {open && (
        <ul id={listId} role="listbox" className="category-options">
          {matches.map((c) => (
            <li key={c} role="option" aria-selected={c === value} className={c === value ? "category-option category-option-current" : "category-option"} onMouseDown={() => choose(c)}>
              {c}
            </li>
          ))}
          {matches.length === 0 && !canCreate && <li className="category-option muted">No category matches.</li>}
          {canCreate && (
            <li role="option" aria-selected={false} className="category-option category-option-add" onMouseDown={createTyped}>
              + Create "{typed}"
            </li>
          )}
        </ul>
      )}
      {value && !open && <span className="muted field-help">Category: {value}</span>}
    </div>
  );
}
