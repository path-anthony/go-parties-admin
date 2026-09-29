import { useEffect, useState } from "react";
import { getBookings, getDesignRequests, getUnits, updateDesignRequest } from "../../lib/api";
import { formatEventDay } from "../../lib/gigs";
import type { DesignRequest } from "../../lib/types";
import { NewBookingModal } from "../NewBookingModal";
import { useNavigate } from "../../lib/navigation";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const STATUSES = ["Open", "Converted", "Dismissed"] as const;
const REASON_TEXT = { threshold: "Over the review threshold", occasion: "Occasion needs review" } as const;

// The review queue: carts that were routed here instead of being held,
// because the total is over the threshold or the occasion is on the
// review list. Nothing on them is locked. Converting one opens New
// booking pre-filled from it, so the same availability, locks and
// agreement rule apply, and staff can change anything (price included)
// before it becomes a real Held booking.
export function DesignRequestsScreen() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("Open");
  const [requests, setRequests] = useState<DesignRequest[] | null>(null);
  // Which tab the list on screen was loaded for. The screen is loading
  // whenever that differs from the tab selected, so clicking the tab that
  // is already selected changes nothing (no reset, no hang).
  const [loadedStatus, setLoadedStatus] = useState<(typeof STATUSES)[number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState<DesignRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getDesignRequests(status)
      .then((rows) => {
        if (!live) return;
        setRequests(rows);
        setLoadedStatus(status);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load the requests"));
    return () => {
      live = false;
    };
  }, [status]);

  async function reload() {
    setRequests(await getDesignRequests(status));
  }

  async function change(id: string, patch: { status?: "Open" | "Dismissed"; notes?: string | null }) {
    setBusyId(id);
    setError(null);
    try {
      await updateDesignRequest(id, patch);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusyId(null);
    }
  }

  const loading = loadedStatus !== status;

  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Design requests</h2>
        <p className="muted">
          Carts that need a person before anything is held: over the review threshold, or for an occasion on the review list.
          Nothing is locked on a request. Both rules are in Settings.
        </p>
      </div>

      <section className="panel">
        <div className="tab-row" role="tablist">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={status === s}
              className={status === s ? "btn-primary" : "btn-secondary"}
              onClick={() => setStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>
        {notice && (
          <p className="bulk-result" role="status">
            {notice}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        {loading && !error && <p className="muted">Loading…</p>}
        {!loading && requests && requests.length === 0 && <p className="muted">No {status.toLowerCase()} requests.</p>}
        {!loading && requests?.map((r) => (
          <div key={r.id} className="policy-version" aria-label={`Design request from ${r.customerName}`}>
            <div>
              <strong>{r.customerName}</strong> · {formatEventDay(r.eventDate)}
              {r.eventTime ? `, ${r.eventTime}` : ""} · {r.total === null ? "No price" : usd(r.total)}
              {r.occasion ? ` · ${r.occasion}` : ""}
            </div>
            <div>
              {r.reasons.map((reason) => (
                <span key={reason} className="reason-pill">
                  {REASON_TEXT[reason]}
                </span>
              ))}
              <span className="muted">
                {r.phone ?? ""} {r.email ? `· ${r.email}` : ""} · received{" "}
                {new Date(r.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}
              </span>
            </div>
            <ul className="request-cart">
              {r.cart.items.map((i) => (
                <li key={i.itemId}>
                  {i.name}
                  {i.quantity > 1 ? ` × ${i.quantity}` : ""}
                  {r.cart.addons
                    .filter((a) => a.itemId === i.itemId)
                    .map((a) => ` · ${a.groupName}: ${a.addonName}`)
                    .join("")}
                </li>
              ))}
            </ul>
            {r.cart.package && <div className="muted">Package: {r.cart.package.name}, {usd(r.cart.package.price)}</div>}
            {r.address && <div className="muted">At {r.address}</div>}
            {r.notes && <div className="muted">Note: {r.notes}</div>}
            <div className="form-actions">
              {r.status === "Open" && (
                <>
                  <button type="button" className="btn-primary" onClick={() => setConverting(r)} disabled={busyId === r.id}>
                    Convert to booking
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => change(r.id, { status: "Dismissed" })} disabled={busyId === r.id}>
                    Dismiss
                  </button>
                </>
              )}
              {r.status === "Dismissed" && (
                <button type="button" className="btn-secondary" onClick={() => change(r.id, { status: "Open" })} disabled={busyId === r.id}>
                  Reopen
                </button>
              )}
              {r.status === "Converted" && (
                <button type="button" className="btn-secondary" onClick={() => navigate("scheduling")}>
                  Open Scheduling
                </button>
              )}
            </div>
          </div>
        ))}
      </section>

      {converting && (
        <NewBookingModal
          request={converting}
          onClose={() => setConverting(null)}
          onCreated={async () => {
            // The booking exists and the request is Converted. Refresh the
            // caches other screens keep so they pick it up on open.
            await Promise.all([getBookings(), getUnits()]);
            setConverting(null);
            setNotice(`Turned ${converting.customerName}'s request into a Held booking. It is in Scheduling.`);
            await reload();
          }}
          onReview={() => setConverting(null)}
        />
      )}
    </div>
  );
}
