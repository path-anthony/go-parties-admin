import { useEffect, useState } from "react";
import { getGigs, getLeadStatuses, getLeads } from "../../lib/api";
import { formatEventDay } from "../../lib/gigs";
import { FOLLOW_UP_DAYS, PROPOSAL_FOLLOW_UP_DAYS, daysSinceUpdate, findStage, needsFollowUp, useNavigate } from "../../lib/navigation";
import type { Gig, Lead } from "../../lib/types";
import { StatCard, StatGrid } from "../StatCard";

// What is not measured yet, and what each one is waiting on, so the
// dashes read as a plan rather than a gap.
const NOT_TRACKED = [
  { label: "Sales this month", waitingOn: "Waiting on payment integration: bookings carry a quoted total, nothing records money received." },
  { label: "Upcoming events (30d)", waitingOn: "Waiting on the calendar view of Scheduling, which counts confirmed events by date." },
  { label: "Contract signed", waitingOn: "Waiting on the e-sign integration (SignWell or Documenso, not yet chosen)." },
  { label: "Retainer status", waitingOn: "Waiting on payment integration: retainer links are not sent or recorded yet." },
  { label: "SMS campaign activity", waitingOn: "Waiting on n8n reporting sends, opens and replies back to this admin." },
];

const NEAREST_GIGS = 3;

// The day as a plain YYYY-MM-DD, for comparing event dates to today.
const today = () => new Date().toISOString().slice(0, 10);

export function OverviewScreen() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [statuses, setStatuses] = useState<string[] | null>(null);
  const [needsCrew, setNeedsCrew] = useState<Gig[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getLeads(), getLeadStatuses(), getGigs("Needs Crew")])
      .then(([leadList, rows, gigs]) => {
        setLeads(leadList);
        setStatuses(rows.map((row) => row.name));
        setNeedsCrew(gigs);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  const ready = leads !== null && statuses !== null && needsCrew !== null;

  // The well-known stages, found by name in the configurable columns.
  const stageNew = statuses ? findStage(statuses, "New") : undefined;
  const stageContacted = statuses ? findStage(statuses, "Contacted") : undefined;
  const stageBooked = statuses ? findStage(statuses, "Booked") : undefined;
  const earlyStages = [stageNew, stageContacted].filter((s): s is string => !!s);
  const countIn = (stage: string | undefined) => (stage ? (leads ?? []).filter((l) => l.status === stage).length : 0);
  const followUps = (leads ?? []).filter((l) => needsFollowUp(l, earlyStages));
  // One row per column, except Proposal sent, which splits into the
  // proposals still fresh and the ones that have sat 5+ days without a
  // touch. Same last-updated clock as the follow-up card; any edit resets
  // it.
  const stageProposal = statuses ? findStage(statuses, "Proposal sent") : undefined;
  const byStage = (statuses ?? []).flatMap((name) => {
    if (name !== stageProposal) return [{ key: name, label: name, count: countIn(name), status: name, staleDays: undefined as number | undefined }];
    const inStage = (leads ?? []).filter((l) => l.status === name);
    const stale = inStage.filter((l) => daysSinceUpdate(l) >= PROPOSAL_FOLLOW_UP_DAYS);
    return [
      { key: `${name}:recent`, label: "Proposal sent", count: inStage.length - stale.length, status: name, staleDays: undefined },
      { key: `${name}:stale`, label: "Needs follow-up", count: stale.length, status: name, staleDays: PROPOSAL_FOLLOW_UP_DAYS },
    ];
  });
  const maxStage = Math.max(1, ...byStage.map((s) => s.count));

  const upcoming = (needsCrew ?? []).filter((g) => g.eventDate.slice(0, 10) >= today());
  const nearest = (upcoming.length > 0 ? upcoming : (needsCrew ?? [])).slice(0, NEAREST_GIGS);

  return (
    <div className="screen">
      <div className="screen-head">
        <h2>Overview</h2>
        <p className="muted">What needs attention today. Every number opens the view behind it.</p>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!ready && !error && <p className="muted">Loading…</p>}

      {ready && (
        <>
          <section className="kpi-section kpi-section-leads">
            <span className="kpi-section-label">Leads</span>
            <StatGrid className="kpi-grid-leads">
              <StatCard
                label="New leads"
                value={countIn(stageNew)}
                note={stageNew ? "Opens the New column" : "No column named New"}
                onClick={stageNew ? () => navigate("leads", { leadStatus: stageNew }) : undefined}
              />
              <StatCard
                label="Contacted"
                value={countIn(stageContacted)}
                note={stageContacted ? "Opens the Contacted column" : "No column named Contacted"}
                onClick={stageContacted ? () => navigate("leads", { leadStatus: stageContacted }) : undefined}
              />
              <StatCard
                label="Follow up needed"
                value={followUps.length}
                note={`New or Contacted, untouched for ${FOLLOW_UP_DAYS}+ days`}
                onClick={earlyStages.length > 0 ? () => navigate("leads", { leadFollowUp: true }) : undefined}
              />
              <StatCard
                label="Booked"
                value={countIn(stageBooked)}
                note={stageBooked ? "Opens the Booked column" : "No column named Booked"}
                onClick={stageBooked ? () => navigate("leads", { leadStatus: stageBooked }) : undefined}
              />
            </StatGrid>

            <div className="stage-block">
              <span className="kpi-label">Leads by stage</span>
              <ul className="stage-bars" aria-label="Leads by stage">
                {byStage.map(({ key, label, count, status, staleDays }) => (
                  <li key={key}>
                    <button
                      type="button"
                      className="stage-bar"
                      title={staleDays ? `Proposals untouched for ${staleDays}+ days` : undefined}
                      onClick={() => navigate("leads", { leadStatus: status, leadStaleDays: staleDays })}
                    >
                      <span className="stage-bar-name">{label}</span>
                      <span className="stage-bar-track" aria-hidden="true">
                        <span className="stage-bar-fill" style={{ width: `${Math.round((count / maxStage) * 100)}%` }} />
                      </span>
                      <span className="stage-bar-count">{count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="kpi-section">
            <span className="kpi-section-label">Crew</span>
            <div className="crew-card">
              <div className="crew-card-head">
                <div>
                  <span className="kpi-label">Bookings needing crew</span>
                  <span className="kpi-value">{needsCrew.length}</span>
                </div>
                <button type="button" className="btn-secondary" onClick={() => navigate("crew", { gigStatus: "Needs Crew" })}>
                  View all ({needsCrew.length})
                </button>
              </div>
              {nearest.length === 0 ? (
                <p className="muted">Every booked service item has someone on it.</p>
              ) : (
                <ul className="crew-card-list" aria-label="Nearest gigs needing crew">
                  {nearest.map((g) => (
                    <li key={g.id}>
                      <button type="button" className="crew-card-row" onClick={() => navigate("crew", { gigStatus: "Needs Crew", gigId: g.id })}>
                        <span className="kpi-list-when">{formatEventDay(g.eventDate)}</span>
                        <span className="crew-card-customer">{g.booking.customerName}</span>
                        <span className="muted">needs a {g.skill}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}

      <section className="kpi-section">
        <span className="kpi-section-label">Not yet tracked</span>
        <StatGrid>
          {NOT_TRACKED.map(({ label, waitingOn }) => (
            <StatCard key={label} label={label} value="--" placeholder note={waitingOn} />
          ))}
        </StatGrid>
      </section>
    </div>
  );
}
