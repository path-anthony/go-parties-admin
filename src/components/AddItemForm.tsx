import { type FormEvent, useId, useState } from "react";
import { createItem } from "../lib/api";
import { isUploadedPhoto } from "../lib/photo";
import { SKILLS, type Skill } from "../lib/skills";
import type { Item, NewItem } from "../lib/types";
import { PhotoDropZone } from "./PhotoDropZone";

const EMPTY: NewItem = { name: "", category: "", price: "", priceUnit: "", notes: "", photoUrl: "", skills: [], startingUnits: 1 };

export function AddItemForm({
  categories,
  onAdded,
  onCancel,
}: {
  // Every category in use across the catalog, the picker's options.
  categories: string[];
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
          {SKILLS.map((skill) => (
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


// A combobox over the categories in use. Typing filters the list; only
// choosing a row sets the value, and only the explicit "+ Add new
// category" row opens a way to type a value that isn't in the list yet.
// Free text never becomes a category on its own.
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
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const q = query.trim().toLowerCase();
  const matches = q === "" ? options : options.filter((c) => c.toLowerCase().includes(q));

  function choose(category: string) {
    onChange(category);
    setQuery("");
    setOpen(false);
    setAdding(false);
  }

  function commitNew() {
    const name = draft.trim();
    if (name === "") return;
    const existing = options.find((c) => c.toLowerCase() === name.toLowerCase());
    // Same name in a different case is the same category, not a new one.
    if (existing) choose(existing);
    else {
      onAddNew(name);
      setQuery("");
      setOpen(false);
      setAdding(false);
    }
    setDraft("");
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
          placeholder={options.length === 0 ? "Type to add the first category" : "Pick from the list, or search it"}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter") {
              // Enter picks the single remaining match; it never creates.
              e.preventDefault();
              if (matches.length === 1) choose(matches[0]);
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
          {matches.length === 0 && <li className="category-option muted">No category matches. Add it below.</li>}
          <li
            role="option"
            aria-selected={false}
            className="category-option category-option-add"
            onMouseDown={() => {
              setOpen(false);
              setAdding(true);
              setDraft(query.trim());
            }}
          >
            + Add new category
          </li>
        </ul>
      )}
      {adding && (
        <div className="category-new">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="New category name"
            aria-label="New category name"
            autoFocus
            maxLength={60}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitNew();
              }
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <button type="button" className="btn-secondary" onClick={commitNew} disabled={draft.trim() === ""}>
            Use it
          </button>
          <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      )}
      {value && !open && <span className="muted field-help">Category: {value}</span>}
    </div>
  );
}
