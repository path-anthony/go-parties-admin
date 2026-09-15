import { type FormEvent, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import {
  createLeadStatus,
  deleteLeadStatus,
  getLeadStatuses,
  getLeads,
  renameLeadStatus,
  reorderLeadStatuses,
} from "../lib/api";
import type { LeadStatusRow } from "../lib/types";
import { EditableCell } from "./EditableCell";

export type ColumnsChange =
  | { type: "rename"; from: string; to: string }
  | { type: "add" }
  | { type: "reorder" }
  | { type: "delete" };

// The add/rename/reorder/delete controls for the Leads board's columns.
// Used by the Settings screen and by the board's own "Manage columns"
// panel; onColumnsChange lets the board update live without a reload.
export function LeadColumnsEditor({
  onColumnsChange,
}: {
  onColumnsChange?: (columns: LeadStatusRow[], change: ColumnsChange) => void;
}) {
  const [columns, setColumns] = useState<LeadStatusRow[] | null>(null);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getLeadStatuses(), getLeads()])
      .then(([rows, leads]) => {
        setColumns(rows);
        const next = new Map<string, number>();
        for (const lead of leads) next.set(lead.status, (next.get(lead.status) ?? 0) + 1);
        setCounts(next);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  function publish(next: LeadStatusRow[], change: ColumnsChange) {
    setColumns(next);
    onColumnsChange?.(next, change);
  }

  function setRowError(id: string, message: string | null) {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    setAddError(null);
    try {
      const row = await createLeadStatus(name);
      publish([...(columns ?? []), row], { type: "add" });
      setNewName("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add column");
    } finally {
      setAdding(false);
    }
  }

  async function handleRename(row: LeadStatusRow, name: string) {
    const updated = await renameLeadStatus(row.id, name);
    publish(
      (columns ?? []).map((c) => (c.id === row.id ? updated : c)),
      { type: "rename", from: row.name, to: updated.name },
    );
    // Leads followed the rename on the server; keep the count under the new name.
    setCounts((prev) => {
      const next = new Map(prev);
      const n = next.get(row.name) ?? 0;
      next.delete(row.name);
      next.set(updated.name, n);
      return next;
    });
  }

  async function handleMove(index: number, direction: -1 | 1) {
    if (!columns) return;
    const target = index + direction;
    if (target < 0 || target >= columns.length) return;
    const ids = columns.map((c) => c.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setError(null);
    try {
      publish(await reorderLeadStatuses(ids), { type: "reorder" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the new order");
    }
  }

  async function handleDelete(row: LeadStatusRow) {
    setRowError(row.id, null);
    try {
      await deleteLeadStatus(row.id);
      publish((columns ?? []).filter((c) => c.id !== row.id), { type: "delete" });
    } catch (err) {
      setRowError(row.id, err instanceof Error ? err.message : "Couldn't delete column");
    }
  }

  return (
    <>
      {error && <p className="form-error">{error}</p>}
      {!columns && !error && <p className="muted">Loading…</p>}

      {columns && (
        <ul className="settings-list">
          {columns.map((row, index) => {
            const count = counts.get(row.name) ?? 0;
            return (
              <li key={row.id}>
                <div className="settings-row">
                  <div className="settings-row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Move ${row.name} up`}
                      disabled={index === 0}
                      onClick={() => handleMove(index, -1)}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Move ${row.name} down`}
                      disabled={index === columns.length - 1}
                      onClick={() => handleMove(index, 1)}
                    >
                      <ArrowDown size={14} />
                    </button>
                  </div>
                  <EditableCell value={row.name} ariaLabel="Column name" onSave={(name) => handleRename(row, name)} />
                  <span className="settings-row-count">
                    {count} {count === 1 ? "lead" : "leads"}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Delete ${row.name}`}
                    onClick={() => handleDelete(row)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {rowErrors[row.id] && <p className="settings-row-error">{rowErrors[row.id]}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <form className="settings-add" onSubmit={handleAdd}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New column name"
          aria-label="New column name"
          maxLength={40}
          disabled={adding}
        />
        <button type="submit" className="btn-secondary" disabled={adding || newName.trim() === ""}>
          {adding ? "Adding…" : "Add column"}
        </button>
      </form>
      {addError && <p className="form-error">{addError}</p>}
    </>
  );
}
