import { useState } from "react";
import { SOURCE_LABEL, leadTitle } from "../lib/leads";
import type { Lead, LeadStatus } from "../lib/types";
import { formatDate, relativeTime } from "../lib/time";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export function LeadCard({
  lead,
  statuses,
  onOpen,
  onStatusChange,
}: {
  lead: Lead;
  statuses: LeadStatus[];
  onOpen: () => void;
  onStatusChange: (id: string, status: LeadStatus) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStatus(status: LeadStatus) {
    setSaving(true);
    setError(null);
    try {
      await onStatusChange(lead.id, status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const title = leadTitle(lead);
  const when = lead.dateOfInterest ? formatDate(lead.dateOfInterest) : null;
  // Occasion is the title when there's no name, so only repeat it here if it isn't.
  const detail = [lead.customerName ? lead.occasion : null, when].filter(Boolean).join(" · ");
  const items = lead.itemsReturned;

  // The card body is both the drag surface and the click-to-open target.
  // Controls inside it stop pointer and click events so using them never
  // starts a drag or opens the detail panel.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <article className="lead-card" onClick={onOpen}>
      <div className="lead-card-top">
        <span className={`lead-source lead-source-${lead.source}`}>{SOURCE_LABEL[lead.source]}</span>
        <span className="lead-time muted">{relativeTime(lead.createdAt)}</span>
      </div>

      {title ? <div className="lead-card-name">{title}</div> : <div className="lead-card-name muted">No contact yet</div>}
      {lead.contact && <div className="lead-card-line">{lead.contact}</div>}
      {detail && <div className="lead-card-line">{detail}</div>}

      {lead.tags.length > 0 && (
        <div className="tag-list">
          {lead.tags.map((tag) => (
            <span key={tag} className="tag-chip">
              {tag}
            </span>
          ))}
        </div>
      )}

      {lead.theme && <p className="lead-card-theme">{lead.theme}</p>}

      {items && (
        <details className="lead-card-items" onClick={stop} onPointerDown={stop}>
          <summary>
            {items.items.length} {items.items.length === 1 ? "item" : "items"} · {usd(items.total)}
          </summary>
          {items.items.length > 0 && (
            <ul>
              {items.items.map((item) => (
                <li key={item.id}>
                  <span>{item.name}</span>
                  <span>{item.price !== null ? usd(item.price) : "TBD"}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {lead.notes && <p className="lead-card-notes muted">{lead.notes}</p>}

      <div className="lead-card-foot" onClick={stop} onPointerDown={stop}>
        <select
          value={lead.status}
          onChange={(e) => handleStatus(e.target.value)}
          disabled={saving}
          aria-label={`Status for ${title ?? "lead"}`}
        >
          {statuses.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        {saving && <span className="cell-status">Saving…</span>}
        {error && <span className="cell-status cell-status-error">{error}</span>}
      </div>
    </article>
  );
}
