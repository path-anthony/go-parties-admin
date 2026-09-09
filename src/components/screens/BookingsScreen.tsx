import { useEffect, useState } from "react";
import { getLeads } from "../../lib/api";
import type { Lead } from "../../lib/types";
import { relativeTime } from "../../lib/time";

export function BookingsScreen() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLeads()
      .then(setLeads)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load leads"));
  }, []);

  return (
    <div className="screen">
      <div className="screen-head">
        <h2>Bookings</h2>
        <p className="muted">Raw Ask GO interest, newest first. No stage tracking yet.</p>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!leads && !error && <p className="muted">Loading…</p>}
      {leads && leads.length === 0 && <p className="muted">Nothing here yet.</p>}

      {leads && leads.length > 0 && (
        <div className="table-scroll">
          <table className="items-table">
            <thead>
              <tr>
                <th>Theme</th>
                <th>Items</th>
                <th>Total</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id}>
                  <td>{lead.theme}</td>
                  <td>{lead.itemsReturned.items.length}</td>
                  <td>
                    {lead.itemsReturned.total.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                  </td>
                  <td>{relativeTime(lead.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
