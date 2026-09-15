import { useEffect, useState } from "react";
import { getItems, getLeads } from "../../lib/api";
import { LEAD_STATUSES, type Item, type Lead, type LeadStatus } from "../../lib/types";

type Stats = {
  total: number;
  priced: number;
  tbd: number;
  categories: number;
  leadsCaptured: number;
  leadsByStage: Record<LeadStatus, number>;
};

const PLACEHOLDER_CARDS = [
  { label: "Sales this month" },
  { label: "Upcoming events (30d)" },
  { label: "Bookings needing crew" },
];

function computeItemStats(items: Item[]) {
  const priced = items.filter((item) => item.price !== null).length;
  return {
    total: items.length,
    priced,
    tbd: items.length - priced,
    categories: new Set(items.map((item) => item.category)).size,
  };
}

function computeLeadStats(leads: Lead[]) {
  const leadsByStage = Object.fromEntries(LEAD_STATUSES.map((status) => [status, 0])) as Record<LeadStatus, number>;
  for (const lead of leads) leadsByStage[lead.status] += 1;
  return { leadsCaptured: leads.length, leadsByStage };
}

export function OverviewScreen() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getItems(), getLeads()])
      .then(([items, leads]) => setStats({ ...computeItemStats(items), ...computeLeadStats(leads) }))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  return (
    <div className="screen">
      <div className="screen-head">
        <h2>Overview</h2>
        <p className="muted">Live counts from the catalog and captured interest.</p>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!stats && !error && <p className="muted">Loading…</p>}

      {stats && (
        <div className="kpi-section">
          <span className="kpi-section-label">Live</span>
          <div className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Total items</span>
              <span className="kpi-value">{stats.total}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Priced</span>
              <span className="kpi-value">{stats.priced}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">TBD / no price</span>
              <span className="kpi-value">{stats.tbd}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Categories</span>
              <span className="kpi-value">{stats.categories}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Leads captured (total)</span>
              <span className="kpi-value">{stats.leadsCaptured}</span>
            </div>
            <div className="kpi-card kpi-card-wide">
              <span className="kpi-label">Leads by stage</span>
              <div className="kpi-stages">
                {LEAD_STATUSES.map((status) => (
                  <div key={status} className="kpi-stage">
                    <span className="kpi-stage-value">{stats.leadsByStage[status]}</span>
                    <span className="kpi-stage-label">{status}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="kpi-section">
        <span className="kpi-section-label">Not yet tracked</span>
        <div className="kpi-grid">
          {PLACEHOLDER_CARDS.map(({ label }) => (
            <div key={label} className="kpi-card kpi-card-placeholder">
              <span className="kpi-label">{label}</span>
              <span className="kpi-value">--</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
