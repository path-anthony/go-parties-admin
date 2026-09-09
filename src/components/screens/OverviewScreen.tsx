import { useEffect, useState } from "react";
import { getItems } from "../../lib/api";
import type { Item } from "../../lib/types";

type Stats = {
  total: number;
  priced: number;
  tbd: number;
  categories: number;
};

function computeStats(items: Item[]): Stats {
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
    getItems()
      .then((items) => setStats(computeStats(items)))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  return (
    <div className="screen">
      <div className="screen-head">
        <h2>Overview</h2>
        <p className="muted">Live counts from the catalog.</p>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!stats && !error && <p className="muted">Loading…</p>}

      {stats && (
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
        </div>
      )}
    </div>
  );
}
