import { useEffect, useState } from "react";
import { getItems, getLeads } from "../../lib/api";
import type { Item } from "../../lib/types";

type Stats = {
  total: number;
  priced: number;
  tbd: number;
  categories: number;
  leadsCaptured: number;
};

const PLACEHOLDER_CARDS = [
  { label: "Sales this month" },
  { label: "Upcoming events (30d)" },
  { label: "Bookings needing crew" },
  { label: "Leads by stage" },
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

export function OverviewScreen() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getItems(), getLeads()])
      .then(([items, leads]) => setStats({ ...computeItemStats(items), leadsCaptured: leads.length }))
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
