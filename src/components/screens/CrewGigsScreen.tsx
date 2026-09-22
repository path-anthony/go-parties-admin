import { type KeyboardEvent, useEffect, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { getCrew, getGigs } from "../../lib/api";
import { GIG_STATUSES, type GigStatus } from "../../lib/skills";
import type { CrewMember, Gig } from "../../lib/types";
import { CrewModal } from "../CrewModal";
import { formatEventDay, gigPillClass } from "../../lib/gigs";
import { GigModal } from "../GigModal";

type Tab = "gigs" | "crew";
type Filter = "All" | GigStatus;

function rowKey(e: KeyboardEvent<HTMLTableRowElement>, open: () => void) {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    open();
  }
}

// Two tabs under one nav entry. Gigs: every person needed for a booked
// service item, filterable by status, one row opening the gig popup.
// Crew: the people, one row opening the crew popup. Both follow the
// compact-row-plus-popup pattern Inventory and Scheduling use.
export function CrewGigsScreen() {
  const [tab, setTab] = useState<Tab>("gigs");
  const [gigs, setGigs] = useState<Gig[] | null>(null);
  const [crew, setCrew] = useState<CrewMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("All");
  const [openGigId, setOpenGigId] = useState<string | null>(null);
  const [crewModal, setCrewModal] = useState<{ mode: "create" } | { mode: "edit"; id: string } | null>(null);

  useEffect(() => {
    Promise.all([getGigs(), getCrew()])
      .then(([gigList, crewList]) => {
        setGigs(gigList);
        setCrew(crewList);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  const ready = gigs !== null && crew !== null;
  const visibleGigs = (gigs ?? []).filter((g) => filter === "All" || g.status === filter);
  const openGig = openGigId ? (gigs ?? []).find((g) => g.id === openGigId) : undefined;
  const editingMember = crewModal?.mode === "edit" ? (crew ?? []).find((m) => m.id === crewModal.id) : undefined;
  const counts = new Map<string, number>();
  for (const g of gigs ?? []) counts.set(g.status, (counts.get(g.status) ?? 0) + 1);

  return (
    <div className="screen screen-wide">
      <div className="screen-head screen-head-row">
        <div>
          <h2>Crew & Gigs</h2>
          <p className="muted">
            A gig is one person needed for one service item on one booking. Crew are the people who can take them.
          </p>
        </div>
        {ready && tab === "crew" && (
          <button type="button" className="btn-primary" onClick={() => setCrewModal({ mode: "create" })}>
            <Plus size={14} /> Add crew member
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {!ready && !error && <p className="muted">Loading…</p>}

      {ready && (
        <section className="panel">
          <div className="filter-row tab-row" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "gigs"} className={tab === "gigs" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("gigs")}>
              Gigs ({gigs.length})
            </button>
            <button type="button" role="tab" aria-selected={tab === "crew"} className={tab === "crew" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("crew")}>
              Crew ({crew.length})
            </button>
          </div>

          {tab === "gigs" && (
            <>
              <div className="filter-row">
                {(["All", ...GIG_STATUSES] as Filter[]).map((f) => (
                  <button key={f} type="button" className={filter === f ? "btn-primary" : "btn-secondary"} onClick={() => setFilter(f)}>
                    {f}
                    {f !== "All" && ` (${counts.get(f) ?? 0})`}
                  </button>
                ))}
              </div>
              {visibleGigs.length === 0 ? (
                <p className="muted">
                  {gigs.length === 0
                    ? "No gigs yet. One appears here for each service item on a booking, the moment the booking is made."
                    : "No gigs match."}
                </p>
              ) : (
                <div className="table-scroll">
                  <table className="items-table scheduling-table">
                    <thead>
                      <tr>
                        <th>Event</th>
                        <th>Customer</th>
                        <th>Item</th>
                        <th>Needs</th>
                        <th>Status</th>
                        <th>Filled by</th>
                        <th>Offers</th>
                        <th aria-label="Open" />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleGigs.map((g) => (
                        <tr
                          key={g.id}
                          className="catalog-row"
                          tabIndex={0}
                          aria-haspopup="dialog"
                          aria-label={`Open the gig for ${g.itemName}, ${g.booking.customerName}`}
                          onClick={() => setOpenGigId(g.id)}
                          onKeyDown={(e) => rowKey(e, () => setOpenGigId(g.id))}
                        >
                          <td className="booking-date">{formatEventDay(g.eventDate)}</td>
                          <td className="catalog-name">{g.booking.customerName}</td>
                          <td>{g.itemName}</td>
                          <td>{g.skill}</td>
                          <td>
                            <span className={gigPillClass(g.status)}>{g.status}</span>
                          </td>
                          <td className={g.filledBy ? "" : "muted"}>{g.filledBy?.name ?? "Nobody yet"}</td>
                          <td className={g.offers.length === 0 ? "muted" : ""}>
                            {g.offers.length === 0
                              ? "None"
                              : `${g.offers.length} sent · ${g.offers.filter((o) => o.status === "Declined").length} declined`}
                          </td>
                          <td className="catalog-chevron">
                            <ChevronRight size={14} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === "crew" && (
            <>
              {crew.length === 0 ? (
                <p className="muted">No crew yet. Add the people who work your events, with the skills they cover.</p>
              ) : (
                <div className="table-scroll">
                  <table className="items-table scheduling-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Skills</th>
                        <th>Phone</th>
                        <th>Email</th>
                        <th>Status</th>
                        <th aria-label="Open" />
                      </tr>
                    </thead>
                    <tbody>
                      {crew.map((m) => (
                        <tr
                          key={m.id}
                          className="catalog-row"
                          tabIndex={0}
                          aria-haspopup="dialog"
                          aria-label={`Open ${m.name}`}
                          onClick={() => setCrewModal({ mode: "edit", id: m.id })}
                          onKeyDown={(e) => rowKey(e, () => setCrewModal({ mode: "edit", id: m.id }))}
                        >
                          <td className="catalog-name">{m.name}</td>
                          <td className={m.skills.length === 0 ? "muted" : ""}>{m.skills.length === 0 ? "None" : m.skills.join(", ")}</td>
                          <td className={m.phone ? "" : "muted"}>{m.phone ?? "None"}</td>
                          <td className={m.email ? "" : "muted"}>{m.email ?? "None"}</td>
                          <td>
                            <span className={m.active ? "status-pill status-pill-live" : "status-pill"}>{m.active ? "Active" : "Inactive"}</span>
                          </td>
                          <td className="catalog-chevron">
                            <ChevronRight size={14} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {openGig && (
        <GigModal
          gig={openGig}
          onClose={() => setOpenGigId(null)}
          onChanged={(updated) => setGigs((prev) => (prev ?? []).map((g) => (g.id === updated.id ? { ...g, ...updated } : g)))}
        />
      )}
      {crewModal && (crewModal.mode === "create" || editingMember) && (
        <CrewModal
          member={editingMember ?? null}
          onClose={() => setCrewModal(null)}
          onSaved={(saved) => {
            setCrew((prev) => {
              const list = prev ?? [];
              const next = list.some((m) => m.id === saved.id) ? list.map((m) => (m.id === saved.id ? saved : m)) : [saved, ...list];
              return [...next].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
            });
            setCrewModal(null);
          }}
        />
      )}
    </div>
  );
}
