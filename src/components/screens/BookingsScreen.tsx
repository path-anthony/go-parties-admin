import { useEffect, useState } from "react";
import { getLeads, updateLeadStatus } from "../../lib/api";
import { LEAD_STATUSES, type Lead, type LeadStatus } from "../../lib/types";
import { AddLeadForm } from "../AddLeadForm";
import { LeadCard } from "../LeadCard";

export function BookingsScreen() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    getLeads()
      .then(setLeads)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load leads"));
  }, []);

  // Optimistic: the card jumps columns immediately, then settles on the
  // server's copy, or jumps back if the save fails (the card shows the error).
  async function handleStatusChange(id: string, status: LeadStatus) {
    const previous = leads?.find((lead) => lead.id === id)?.status;
    setLeads((prev) => (prev ?? []).map((lead) => (lead.id === id ? { ...lead, status } : lead)));
    try {
      const updated = await updateLeadStatus(id, status);
      setLeads((prev) => (prev ?? []).map((lead) => (lead.id === id ? updated : lead)));
    } catch (err) {
      if (previous) {
        setLeads((prev) => (prev ?? []).map((lead) => (lead.id === id ? { ...lead, status: previous } : lead)));
      }
      throw err;
    }
  }

  return (
    <div className="screen screen-wide">
      <div className="screen-head screen-head-row">
        <div>
          <h2>Bookings</h2>
          <p className="muted">Every lead, grouped by stage. Newest first in each column.</p>
        </div>
        {!adding && (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            Add lead
          </button>
        )}
      </div>

      {adding && (
        <section className="panel">
          <h2>New lead</h2>
          <AddLeadForm
            onAdded={(lead) => {
              setLeads((prev) => [lead, ...(prev ?? [])]);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </section>
      )}

      {error && <p className="form-error">{error}</p>}
      {!leads && !error && <p className="muted">Loading…</p>}

      {leads && (
        <div className="pipeline">
          {LEAD_STATUSES.map((status) => {
            const column = leads.filter((lead) => lead.status === status);
            return (
              <section key={status} className={`pipeline-col pipeline-col-${status.toLowerCase()}`}>
                <header className="pipeline-col-head">
                  <span className="pipeline-col-title">{status}</span>
                  <span className="pipeline-col-count">{column.length}</span>
                </header>
                <div className="pipeline-col-body">
                  {column.length === 0 ? (
                    <p className="muted pipeline-empty">Nothing here yet.</p>
                  ) : (
                    column.map((lead) => <LeadCard key={lead.id} lead={lead} onStatusChange={handleStatusChange} />)
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
