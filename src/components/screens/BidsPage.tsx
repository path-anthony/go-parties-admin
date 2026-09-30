import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBidsSummary } from "../../lib/api";
import { formatEventDay } from "../../lib/gigs";
import type { BidsSummaryRow } from "../../lib/types";

const stamp = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

// Every gig that is out for bids or waiting on a pick. Click one to open it.
export function BidsPage() {
  const [rows, setRows] = useState<BidsSummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    getBidsSummary()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load bids"));
  }, []);

  const ready = (rows ?? []).filter((r) => r.readyToPick).length;
  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Bids</h2>
        <p className="muted">Gigs out for bids or waiting on a pick. Open a gig to see each bid and accept one. A gig is ready to pick once its deadline has passed and at least one bid is in.</p>
      </div>
      {error && <p className="form-error">{error}</p>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="muted">Nothing is out for bids. Invite crew from a gig under Crew &amp; Gigs, Gigs.</p>}
      {ready > 0 && <p className="bulk-result">{ready} {ready === 1 ? "gig is" : "gigs are"} ready to pick.</p>}
      {rows && rows.length > 0 && (
        <section className="panel table-scroll">
          <table className="items-table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Date</th>
                <th>Town</th>
                <th>Invited</th>
                <th>Bids in</th>
                <th>Declined</th>
                <th>Lowest bid</th>
                <th>Deadline</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/crew/gigs?gig=${r.id}`}>{r.role}</Link>
                    <div className="muted">{r.itemName}</div>
                  </td>
                  <td>{formatEventDay(r.eventDate)}</td>
                  <td>{r.town ?? <span className="muted">not set</span>}</td>
                  <td>{r.invited}</td>
                  <td>{r.bidsIn}</td>
                  <td>{r.declines}</td>
                  <td>{r.lowestBid !== null ? `$${r.lowestBid.toLocaleString("en-US")}` : <span className="muted">none yet</span>}</td>
                  <td>{r.deadlineAt ? stamp(r.deadlineAt) : "None"}</td>
                  <td>{r.readyToPick ? <span className="status-pill status-pill-live">Ready to pick</span> : r.deadlineAt && new Date(r.deadlineAt).getTime() < now ? <span className="status-pill">Closed, no bids</span> : <span className="status-pill">Open</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
