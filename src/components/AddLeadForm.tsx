import { type FormEvent, useState } from "react";
import { createLead } from "../lib/api";
import { LEAD_STATUSES, type Lead, type NewLead } from "../lib/types";

const EMPTY: NewLead = { customerName: "", contact: "", occasion: "", dateOfInterest: "", notes: "", status: "New" };

export function AddLeadForm({ onAdded, onCancel }: { onAdded: (lead: Lead) => void; onCancel: () => void }) {
  const [form, setForm] = useState<NewLead>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof NewLead>(key: K, value: NewLead[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const lead = await createLead(form);
      onAdded(lead);
      setForm(EMPTY);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add lead");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="add-lead-form">
      <div className="field-row">
        <label>
          Customer name*
          <input value={form.customerName} onChange={(e) => set("customerName", e.target.value)} required />
        </label>
        <label>
          Phone or email*
          <input value={form.contact} onChange={(e) => set("contact", e.target.value)} required />
        </label>
      </div>
      <div className="field-row">
        <label>
          Occasion
          <input
            value={form.occasion}
            onChange={(e) => set("occasion", e.target.value)}
            placeholder="e.g. 40th birthday"
          />
        </label>
        <label>
          Date of interest
          <input type="date" value={form.dateOfInterest} onChange={(e) => set("dateOfInterest", e.target.value)} />
        </label>
        <label>
          Status
          <select value={form.status} onChange={(e) => set("status", e.target.value as NewLead["status"])}>
            {LEAD_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Notes
        <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Adding…" : "Add lead"}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
