import { useEffect, useState } from "react";
import { getGigs, getItems, getLeadStatuses, getLeads } from "../../lib/api";
import type { Gig, Item, Lead } from "../../lib/types";
import { formatEventDay } from "../../lib/gigs";

type Stats = {
  total: number;
  priced: number;
  tbd: number;
  categories: number;
  leadsCaptured: number;
  leadsByStage: { name: string; count: number }[];
};

const PLACEHOLDER_CARDS = [{ label: "Sales this month" }, { label: "Upcoming events (30d)" }];

function computeItemStats(items: Item[]) {
  const priced = items.filter((item) => item.price !== null).length;
  return {
    total: items.length,
    priced,
    tbd: items.length - priced,
    categories: new Set(items.map((item) => item.category)).size,
  };
}

function computeLeadStats(leads: Lead[], stages: string[]) {
  const counts = new Map(stages.map((name) => [name, 0]));
  for (const lead of leads) counts.set(lead.status, (counts.get(lead.status) ?? 0) + 1);
  return {
    leadsCaptured: leads.length,
    leadsByStage: stages.map((name) => ({ name, count: counts.get(name) ?? 0 })),
  };
}

export function OverviewScreen() {
  const [stats, setStats] = useState<Stats | null>(null);
  // Gigs still needing someone, soonest first, for the crew card.
  const [needsCrew, setNeedsCrew] = useState<Gig[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getItems(), getLeads(), getLeadStatuses(), getGigs("Needs Crew")])
      .then(([items, leads, statuses, gigs]) => {
        setStats({
          ...computeItemStats(items),
          ...computeLeadStats(
            leads,
            statuses.map((row) => row.name),
          ),
        });
        setNeedsCrew(gigs);
      })
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
              <span className="kpi-label">Bookings needing crew</span>
              <span className="kpi-value">{needsCrew?.length ?? 0}</span>
              {needsCrew && needsCrew.length > 0 && (
                <ul className="kpi-list" aria-label="Gigs needing crew">
                  {needsCrew.slice(0, 6).map((g) => (
                    <li key={g.id}>
                      <span className="kpi-list-when">{formatEventDay(g.eventDate)}</span> {g.booking.customerName}
                      <span className="muted">
                        {" "}
                        · {g.itemName} · needs a {g.skill}
                      </span>
                    </li>
                  ))}
                  {needsCrew.length > 6 && <li className="muted">and {needsCrew.length - 6} more under Crew & Gigs</li>}
                </ul>
              )}
              {needsCrew && needsCrew.length === 0 && <span className="muted kpi-note">Every booked service item has someone on it.</span>}
            </div>
            <div className="kpi-card kpi-card-wide">
              <span className="kpi-label">Leads by stage</span>
              <div className="kpi-stages">
                {stats.leadsByStage.map(({ name, count }) => (
                  <div key={name} className="kpi-stage">
                    <span className="kpi-stage-value">{count}</span>
                    <span className="kpi-stage-label">{name}</span>
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
