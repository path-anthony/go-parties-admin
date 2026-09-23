import { type FormEvent, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { createSkill, deleteSkill, getSkills, renameSkill } from "../lib/api";
import type { SkillRow } from "../lib/types";
import { EditableCell } from "./EditableCell";

// The crew skills, managed here and read everywhere else: the item
// popup, the new-item form, the crew popup and the bulk importer all
// list what this list holds. A rename follows through to every item,
// crew member and gig; a delete is refused while an item or a crew
// member still lists the skill.
export function SkillsEditor() {
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    getSkills()
      .then(setSkills)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load skills"));
  }, []);

  function replace(updated: SkillRow) {
    setSkills((prev) => (prev ?? []).map((s) => (s.id === updated.id ? updated : s)));
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      const row = await createSkill(newName);
      setSkills((prev) => [...(prev ?? []), row]);
      setNewName("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Couldn't add the skill");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(row: SkillRow) {
    setRowErrors((prev) => ({ ...prev, [row.id]: "" }));
    try {
      await deleteSkill(row.id);
      setSkills((prev) => (prev ?? []).filter((s) => s.id !== row.id));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [row.id]: err instanceof Error ? err.message : "Couldn't delete" }));
    } finally {
      setConfirming(null);
    }
  }

  if (error) return <p className="form-error">{error}</p>;
  if (!skills) return <p className="muted">Loading…</p>;

  return (
    <div className="skills-editor">
      {skills.length === 0 && <p className="muted">No skills yet.</p>}
      <ul className="addon-list">
        {skills.map((row) => {
          const inUse = row.usedByItems > 0 || row.usedByCrew > 0;
          return (
            <li key={row.id} className="skill-row">
              <EditableCell
                value={row.name}
                ariaLabel={`Name of the ${row.name} skill`}
                onSave={async (value) => replace(await renameSkill(row.id, value))}
              />
              <span className="muted skill-usage">
                {inUse
                  ? [row.usedByItems > 0 ? `${row.usedByItems} ${row.usedByItems === 1 ? "item" : "items"}` : null, row.usedByCrew > 0 ? `${row.usedByCrew} crew` : null]
                      .filter(Boolean)
                      .join(", ")
                  : "not in use"}
              </span>
              {confirming === row.id ? (
                <span className="addon-confirm">
                  <span className="muted">Delete {row.name}?</span>
                  <button type="button" className="btn-secondary btn-danger" onClick={() => handleDelete(row)}>
                    Yes, delete
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setConfirming(null)}>
                    Keep it
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete the ${row.name} skill`}
                  title={inUse ? "In use; remove it from those items and crew first" : "Delete"}
                  onClick={() => (inUse ? handleDelete(row) : setConfirming(row.id))}
                >
                  <Trash2 size={14} />
                </button>
              )}
              {rowErrors[row.id] && <p className="form-error skill-row-error">{rowErrors[row.id]}</p>}
            </li>
          );
        })}
      </ul>
      <form className="tag-editor" onSubmit={handleAdd}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New skill, e.g. Stilt Walker"
          aria-label="New skill name"
          maxLength={60}
          disabled={adding}
        />
        <button type="submit" className="btn-secondary" disabled={adding || newName.trim() === ""}>
          Add skill
        </button>
      </form>
      {addError && <p className="form-error">{addError}</p>}
    </div>
  );
}
