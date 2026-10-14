import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { getItems, getServiceRows, saveServiceRows } from "../lib/api";
import type { Item, ServiceRow, ServiceRowInput } from "../lib/types";

// The SERVICES SELECTED table: its rows in two columns, and what each row
// gathers from a booking (catalog categories, words an item's name may
// contain, specific items). "Miscellaneous" and "Rental Options" are where
// anything unclaimed lands, so they stay.
export function ServiceRowsEditor() {
  const [rows, setRows] = useState<ServiceRowInput[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (list: ServiceRow[]) => {
    const input = list.map(({ id, column, label, isGroupHeading, categories, itemWords, itemIds }) => ({ id, column, label, isGroupHeading, categories, itemWords, itemIds }));
    setRows(input);
    setSaved(JSON.stringify(input));
  };
  useEffect(() => {
    Promise.all([getServiceRows().then((r) => apply(r.rows)), getItems().then(setItems)]).catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the service rows"));
  }, []);

  const categories = [...new Set(items.map((i) => i.category))].sort();
  const dirty = rows !== null && saved !== JSON.stringify(rows);

  function update(i: number, patch: Partial<ServiceRowInput>) {
    setRows((r) => (r ? r.map((row, k) => (k === i ? { ...row, ...patch } : row)) : r));
  }
  function move(i: number, dir: -1 | 1) {
    setRows((r) => {
      if (!r) return r;
      const list = [...r];
      const j = i + dir;
      if (j < 0 || j >= list.length) return r;
      [list[i], list[j]] = [list[j], list[i]];
      return list;
    });
  }
  async function save() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      apply((await saveServiceRows(rows)).rows);
      setMessage("Saved. Contracts opened from now on use these rows.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  if (!rows) return error ? <p className="form-error">{error}</p> : <p className="muted">Loading…</p>;
  const listText = (v: string[]) => v.join(", ");
  const parseList = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

  return (
    <div>
      <p className="muted settings-help">
        Each row says which catalog categories, item name words and specific items it gathers. A booked item lands in the first row that claims it (item, then category, then name word). Unclaimed
        services go to Miscellaneous; unclaimed rentals to Rental Options.
      </p>
      {(["left", "right"] as const).map((col) => (
        <div key={col} className="service-col-editor">
          <span className="detail-field-label">{col === "left" ? "Left column" : "Right column"}</span>
          {rows.map((row, i) =>
            row.column !== col ? null : (
              <div key={row.id ?? `new-${i}`} className="service-row-editor">
                <div className="service-row-head">
                  <input value={row.label} disabled={busy} maxLength={120} onChange={(e) => update(i, { label: e.target.value })} aria-label={`Row ${i + 1} label`} />
                  <label className="checkbox-label">
                    <input type="checkbox" checked={row.isGroupHeading} disabled={busy} onChange={(e) => update(i, { isGroupHeading: e.target.checked })} />
                    heading only
                  </label>
                  <span className="form-actions">
                    <button type="button" className="icon-btn" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                      <ArrowUp size={14} />
                    </button>
                    <button type="button" className="icon-btn" disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                      <ArrowDown size={14} />
                    </button>
                    <button type="button" className="icon-btn" disabled={busy || rows.length <= 1 || row.label === "Miscellaneous" || row.label === "Rental Options"} onClick={() => setRows((r) => r?.filter((_, k) => k !== i) ?? r)} aria-label="Remove row">
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
                {!row.isGroupHeading && (
                  <div className="service-row-maps">
                    <label>
                      Categories
                      <select multiple value={row.categories} disabled={busy} onChange={(e) => update(i, { categories: [...e.target.selectedOptions].map((o) => o.value) })} size={3}>
                        {categories.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Name words (comma separated)
                      <input value={listText(row.itemWords)} disabled={busy} onChange={(e) => update(i, { itemWords: parseList(e.target.value) })} />
                    </label>
                    <label>
                      Specific items
                      <select multiple value={row.itemIds} disabled={busy} onChange={(e) => update(i, { itemIds: [...e.target.selectedOptions].map((o) => o.value) })} size={3}>
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </div>
            ),
          )}
          <button type="button" className="btn-secondary" disabled={busy || rows.length >= 60} onClick={() => setRows((r) => [...(r ?? []), { column: col, label: "", isGroupHeading: false, categories: [], itemWords: [], itemIds: [] }])}>
            Add a row to the {col} column
          </button>
        </div>
      ))}
      <div className="form-actions">
        <button type="button" className="btn-primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : "Save rows"}
        </button>
        {message && <span className="muted">{message}</span>}
        {error && <span className="form-error">{error}</span>}
      </div>
    </div>
  );
}
