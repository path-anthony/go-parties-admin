import { useState } from "react";
import { X } from "lucide-react";
import { updateLead } from "../lib/api";
import { LEAD_STATUSES, type Lead, type LeadPatch, type LeadStatus } from "../lib/types";
import { relativeTime } from "../lib/time";
import { EditableCell } from "./EditableCell";
import { SOURCE_LABEL, leadTitle } from "./LeadCard";

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
  onClose,
  onUpdated,
}: {
  lead: Lead | null;
  onClose: () => void;
  onUpdated: (lead: Lead, movedColumns: boolean) => void;
}) {
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  async function save(patch: LeadPatch) {
    if (!lead) return;
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

  const open = lead !== null;
  const items = lead?.itemsReturned ?? null;

  return (
    <>
      {open && <div className="panel-backdrop" onClick={onClose} />}
      <aside className={open ? "side-panel side-panel-open" : "side-panel"} aria-hidden={!open}>
        {lead && (
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
                  onChange={(e) => handleStatus(e.target.value as LeadStatus)}
                  disabled={statusSaving}
                  aria-label="Status"
                >
                  {LEAD_STATUSES.map((status) => (
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
              <p className="muted">Nothing here yet.</p>
            </div>

            <div className="detail-section">
              <span className="detail-field-label">Activity</span>
              <p className="muted">Nothing here yet.</p>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
