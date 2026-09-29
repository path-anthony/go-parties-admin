import { useId, useState } from "react";

// One combobox over the categories in use. Typing filters the list live;
// choosing a row sets the value. When nothing matches what was typed
// exactly (case-insensitively), the last row offers to create it, and
// choosing that row creates and applies it in one step. Free text on its
// own never becomes a category, and a name that matches an existing
// category in a different case reuses the existing one.
export function CategoryPicker({
  options,
  value,
  onChange,
  onAddNew,
  label = "Category*",
}: {
  // The visible label; null when the caller already shows one.
  label?: string | null;
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
        {label}
        <input
          aria-label={label ?? "Category"}
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
