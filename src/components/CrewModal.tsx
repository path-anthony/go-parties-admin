import { type FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";
import { createCrewMember, updateCrewMember } from "../lib/api";
import { SKILLS, type Skill } from "../lib/skills";
import type { CrewMember, CrewMemberInput } from "../lib/types";

function toInput(member: CrewMember | null): CrewMemberInput {
  return {
    name: member?.name ?? "",
    phone: member?.phone ?? "",
    email: member?.email ?? "",
    skills: member?.skills ?? [],
    active: member?.active ?? true,
    notes: member?.notes ?? "",
  };
}

// Add and edit a crew member in a popup, the package builder's pattern: a
// form with one Save. There is no delete; the Active toggle is how
// someone is retired, which keeps the gigs they filled.
export function CrewModal({
  member,
  onClose,
  onSaved,
}: {
  member: CrewMember | null;
  onClose: () => void;
  onSaved: (member: CrewMember) => void;
}) {
  const [form, setForm] = useState<CrewMemberInput>(() => toInput(member));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function set<K extends keyof CrewMemberInput>(key: K, value: CrewMemberInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleSkill(skill: Skill, on: boolean) {
    set("skills", on ? [...new Set([...form.skills, skill])] : form.skills.filter((s) => s !== skill));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(member ? await updateCrewMember(member.id, form) : await createCrewMember(form));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={member ? `Edit ${member.name}` : "New crew member"} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{member ? member.name : "New crew member"}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <form className="modal-form" onSubmit={handleSubmit}>
          <div className="modal-grid">
            <label>
              Name*
              <input value={form.name} onChange={(e) => set("name", e.target.value)} required autoFocus maxLength={120} />
            </label>
            <label className="checkbox-label crew-active">
              <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
              Active, can be offered gigs
            </label>
            <label>
              Phone
              <input value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="860 555 0134" inputMode="tel" maxLength={120} />
            </label>
            <label>
              Email
              <input value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="name@email.com" inputMode="email" maxLength={120} />
            </label>
          </div>

          <div className="detail-field">
            <span className="detail-field-label">Skills</span>
            <div className="skill-grid" role="group" aria-label="Skills">
              {SKILLS.map((skill) => (
                <label key={skill} className="checkbox-label">
                  <input type="checkbox" checked={form.skills.includes(skill)} onChange={(e) => toggleSkill(skill, e.target.checked)} />
                  {skill}
                </label>
              ))}
            </div>
            {form.skills.length === 0 && <span className="muted field-help">With no skills, this person is never offered a gig.</span>}
          </div>

          <label>
            Notes
            <textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} maxLength={2000} placeholder="Availability, rates, anything the crew lead should know" />
          </label>

          {error && <p className="form-error">{error}</p>}

          <div className="modal-foot">
            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? "Saving…" : member ? "Save changes" : "Add crew member"}
              </button>
              <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
                Cancel
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
