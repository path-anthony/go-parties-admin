import { type FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";
import { addLeadActivity, getLeadActivity, updateLead } from "../lib/api";
import type { Lead, LeadActivity, LeadPatch, LeadStatus } from "../lib/types";
import { relativeTime } from "../lib/time";
import { SOURCE_LABEL, leadTitle } from "../lib/leads";
import { EditableCell } from "./EditableCell";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

type TextField = "customerName" | "contact" | "occasion" | "notes";
const TEXT_FIELDS: { key: TextField; label: string; multiline?: boolean }[] = [
  { key: "customerName", label: "Customer name" },
  { key: "contact", label: "Phone or email" },
  { key: "occasion", label: "Occasion" },
  { key: "notes", label: "Notes", multiline: true },
];

export function LeadDetailPanel({
  lead,
  statuses,
  onClose,
  onUpdated,
}: {
  lead: Lead | null;
  statuses: LeadStatus[];
  onClose: () => void;
  onUpdated: (lead: Lead, movedColumns: boolean) => void;
}) {
  const open = lead !== null;
  return (
    <>
      {open && <div className="panel-backdrop" onClick={onClose} />}
      <aside className={open ? "side-panel side-panel-open" : "side-panel"} aria-hidden={!open}>
        {lead && (
          // Keyed by id so drafts, errors, and the activity fetch all reset
          // when a different lead opens.
          <LeadDetailBody key={lead.id} lead={lead} statuses={statuses} onClose={onClose} onUpdated={onUpdated} />
        )}
      </aside>
    </>
  );
}

function LeadDetailBody({
  lead,
  statuses,
  onClose,
  onUpdated,
}: {
  lead: Lead;
  statuses: LeadStatus[];
  onClose: () => void;
  onUpdated: (lead: Lead, movedColumns: boolean) => void;
}) {
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [tagSaving, setTagSaving] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [activity, setActivity] = useState<LeadActivity[] | null>(null);
  const [activityDraft, setActivityDraft] = useState("");
  const [activitySaving, setActivitySaving] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLeadActivity(lead.id)
      .then((entries) => {
        if (!cancelled) setActivity(entries);
      })
      .catch((err) => {
        if (!cancelled) setActivityError(err instanceof Error ? err.message : "Failed to load activity");
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id]);

  async function save(patch: LeadPatch) {
    const updated = await updateLead(lead.id, patch);
    onUpdated(updated, updated.status !== lead.status);
  }

  async function handleStatus(status: LeadStatus) {
    setStatusSaving(true);
    setStatusError(null);
    try {
      await save({ status });
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setStatusSaving(false);
    }
  }

  async function saveTags(tags: string[]) {
    setTagSaving(true);
    setTagError(null);
    try {
      await save({ tags });
    } catch (err) {
      setTagError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setTagSaving(false);
    }
  }

  async function handleAddTag(e: FormEvent) {
    e.preventDefault();
    const tag = tagDraft.trim();
    if (!tag) return;
    if (lead.tags.includes(tag)) {
      setTagDraft("");
      return;
    }
    await saveTags([...lead.tags, tag]);
    setTagDraft("");
  }

  async function handleAddActivity(e: FormEvent) {
    e.preventDefault();
    const text = activityDraft.trim();
    if (!text) return;
    setActivitySaving(true);
    setActivityError(null);
    try {
      const entry = await addLeadActivity(lead.id, text);
      setActivity((prev) => [entry, ...(prev ?? [])]);
      setActivityDraft("");
    } catch (err) {
      setActivityError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setActivitySaving(false);
    }
  }

  const items = lead.itemsReturned;

  return (
    <>
      <div className="side-panel-head">
        <h2>{leadTitle(lead) ?? "Lead"}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close lead">
          <X size={16} />
        </button>
      </div>

      <div className="detail-meta">
        <span className={`lead-source lead-source-${lead.source}`}>{SOURCE_LABEL[lead.source]}</span>
        <span className="muted">Added {relativeTime(lead.createdAt)}</span>
        <span className="muted">Updated {relativeTime(lead.updatedAt)}</span>
      </div>

      <div className="detail-field">
        <span className="detail-field-label">Status</span>
        <div className="lead-card-foot detail-status">
          <select
            value={lead.status}
            onChange={(e) => handleStatus(e.target.value)}
            disabled={statusSaving}
            aria-label="Status"
          >
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          {statusSaving && <span className="cell-status">Saving…</span>}
          {statusError && <span className="cell-status cell-status-error">{statusError}</span>}
        </div>
      </div>

      {TEXT_FIELDS.map(({ key, label, multiline }) => (
        <div key={key} className="detail-field">
          <span className="detail-field-label">{label}</span>
          <EditableCell
            value={lead[key] ?? ""}
            multiline={multiline}
            ariaLabel={label}
            onSave={(value) => save({ [key]: value })}
          />
        </div>
      ))}

      <div className="detail-field">
        <span className="detail-field-label">Date of interest</span>
        <EditableCell
          type="date"
          value={lead.dateOfInterest?.slice(0, 10) ?? ""}
          ariaLabel="Date of interest"
          onSave={(value) => save({ dateOfInterest: value === "" ? null : value })}
        />
      </div>

      {(lead.theme || items) && (
        <div className="detail-section">
          <span className="detail-field-label">Ask GO</span>
          {lead.theme && <p className="lead-card-theme">{lead.theme}</p>}
          {items && items.items.length > 0 && (
            <ul className="item-list">
              {items.items.map((item) => (
                <li key={item.id} className="item-row">
                  <span className="item-name">
                    {item.name}
                    <span className="item-category"> · {item.category}</span>
                  </span>
                  <span className="item-price">{item.price !== null ? usd(item.price) : "TBD"}</span>
                </li>
              ))}
            </ul>
          )}
          {items && (
            <div className="total-row">
              <span>Total</span>
              <span>{usd(items.total)}</span>
            </div>
          )}
        </div>
      )}

      <div className="detail-section">
        <span className="detail-field-label">Tags</span>
        {lead.tags.length > 0 ? (
          <div className="tag-list">
            {lead.tags.map((tag) => (
              <span key={tag} className="tag-chip">
                {tag}
                <button
                  type="button"
                  className="tag-chip-remove"
                  aria-label={`Remove tag ${tag}`}
                  disabled={tagSaving}
                  onClick={() => saveTags(lead.tags.filter((t) => t !== tag))}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">No tags yet.</p>
        )}
        <form className="tag-editor" onSubmit={handleAddTag}>
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            placeholder="Add a tag"
            aria-label="New tag"
            maxLength={40}
            disabled={tagSaving}
          />
          <button type="submit" className="btn-secondary" disabled={tagSaving || tagDraft.trim() === ""}>
            Add
          </button>
        </form>
        {tagError && <p className="form-error">{tagError}</p>}
      </div>

      <div className="detail-section">
        <span className="detail-field-label">Activity</span>
        <form className="activity-form" onSubmit={handleAddActivity}>
          <textarea
            rows={2}
            value={activityDraft}
            onChange={(e) => setActivityDraft(e.target.value)}
            placeholder="What happened?"
            aria-label="New activity entry"
            maxLength={2000}
            disabled={activitySaving}
          />
          <div className="form-actions">
            <button type="submit" className="btn-secondary" disabled={activitySaving || activityDraft.trim() === ""}>
              {activitySaving ? "Adding…" : "Add entry"}
            </button>
          </div>
        </form>
        {activityError && <p className="form-error">{activityError}</p>}
        {!activity && !activityError && <p className="muted">Loading…</p>}
        {activity && activity.length === 0 && <p className="muted">Nothing here yet.</p>}
        {activity && activity.length > 0 && (
          <ul className="activity-list">
            {activity.map((entry) => (
              <li key={entry.id} className="activity-entry">
                <span className="activity-time">{relativeTime(entry.createdAt)}</span>
                {entry.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
