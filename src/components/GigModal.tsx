import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getGig, sendGigOffers, updateGigOffer } from "../lib/api";
import { formatEventDay, gigPillClass } from "../lib/gigs";
import type { Gig, GigDetail } from "../lib/types";

// One gig: where it came from, who could take it, who was asked, who said
// yes. Offers are records only for now; nothing is sent anywhere.
export function GigModal({ gig: summary, onClose, onChanged }: { gig: Gig; onClose: () => void; onChanged: (gig: Gig) => void }) {
  const [gig, setGig] = useState<GigDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Who to offer this round. Everyone eligible starts checked; the admin
  // unchecks anyone not wanted. People who already have an offer are
  // listed but can't be picked again.
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    getGig(summary.id)
      .then((detail) => {
        if (!alive) return;
        setGig(detail);
        const offered = new Set(detail.offers.map((o) => o.crewMemberId));
        setPicked(new Set(detail.candidates.filter((c) => !offered.has(c.id)).map((c) => c.id)));
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : "Couldn't load the gig"));
    return () => {
      alive = false;
    };
  }, [summary.id]);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function apply(detail: GigDetail) {
    setGig(detail);
    onChanged(detail);
    const offered = new Set(detail.offers.map((o) => o.crewMemberId));
    setPicked((prev) => new Set([...prev].filter((id) => !offered.has(id))));
  }

  async function run(action: () => Promise<GigDetail>, done?: (detail: GigDetail) => string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const detail = await action();
      apply(detail);
      if (done) setNotice(done(detail));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const g = gig ?? summary;
  const cancelled = g.status === "Cancelled";
  const offeredIds = new Set(g.offers.map((o) => o.crewMemberId));
  const candidates = gig?.candidates ?? [];
  const open = candidates.filter((c) => !offeredIds.has(c.id));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Gig: ${g.itemName}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            {g.itemName}
            <span className={`${gigPillClass(g.status)} booking-pill`}>{g.status}</span>
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="catalog-detail">
          <div className="detail-field">
            <span className="detail-field-label">Needs</span>
            <span>{g.skill}</span>
          </div>
          <div className="detail-field">
            <span className="detail-field-label">Event</span>
            <span>
              {formatEventDay(g.eventDate)}
              {g.booking.eventTime ? `, ${g.booking.eventTime}` : ""}
            </span>
          </div>
          <div className="detail-field">
            <span className="detail-field-label">Booking</span>
            <span>
              {g.booking.customerName} <span className="muted">· {g.booking.status}</span>
            </span>
          </div>
          <div className="detail-field">
            <span className="detail-field-label">Filled by</span>
            <span className={g.filledBy ? "" : "muted"}>{g.filledBy?.name ?? "Nobody yet"}</span>
          </div>
        </div>

        {error && (
          <p className="form-error booking-notice" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="bulk-result" role="status">
            {notice}
          </p>
        )}

        {cancelled ? (
          <div className="modal-section">
            <p className="muted">This gig was cancelled with its booking. Nothing more to do here.</p>
          </div>
        ) : (
          <>
            <div className="modal-section">
              <span className="detail-field-label">Who could take it</span>
              {!gig && !error && <p className="muted">Loading…</p>}
              {gig && candidates.length === 0 && (
                <p className="muted">Nobody active on the crew has the {g.skill} skill. Add someone under the Crew tab first.</p>
              )}
              {gig && candidates.length > 0 && (
                <>
                  <p className="muted addon-help">
                    Every active crew member with the {g.skill} skill. Uncheck anyone you don't want to ask this round, then send. Sending
                    only records the offer for now; no text goes out yet.
                  </p>
                  <ul className="addon-list">
                    {candidates.map((member) => {
                      const existing = g.offers.find((o) => o.crewMemberId === member.id);
                      return (
                        <li key={member.id} className="crew-candidate">
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={existing ? false : picked.has(member.id)}
                              disabled={busy || !!existing}
                              onChange={(e) =>
                                setPicked((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(member.id);
                                  else next.delete(member.id);
                                  return next;
                                })
                              }
                            />
                            {member.name}
                          </label>
                          <span className="muted">
                            {[member.phone, member.email].filter(Boolean).join(" · ") || "No contact details"}
                            {existing ? ` · already offered (${existing.status})` : ""}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={busy || picked.size === 0}
                      onClick={() =>
                        run(
                          () => sendGigOffers(g.id, [...picked]),
                          (detail) => {
                            const n = (detail as GigDetail & { offered?: number }).offered ?? picked.size;
                            return `Recorded ${n} ${n === 1 ? "offer" : "offers"}. Nothing was sent; mark each one below as the person answers.`;
                          },
                        )
                      }
                    >
                      Send offers to selected ({picked.size})
                    </button>
                    {open.length === 0 && <span className="muted">Everyone eligible has been offered this gig.</span>}
                  </div>
                </>
              )}
            </div>

            <div className="modal-section">
              <span className="detail-field-label">Offers</span>
              {g.offers.length === 0 ? (
                <p className="muted">No offers yet.</p>
              ) : (
                <ul className="addon-list">
                  {g.offers.map((offer) => (
                    <li key={offer.id} className="crew-offer">
                      <span>
                        <strong>{offer.crewMember.name}</strong>
                        {!offer.crewMember.active && <span className="muted"> · inactive</span>}
                      </span>
                      <span className={offer.status === "Accepted" ? "status-pill status-pill-live" : "status-pill"}>{offer.status}</span>
                      <span className="form-actions">
                        {offer.status !== "Accepted" && (
                          <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => updateGigOffer(g.id, offer.id, "Accepted"))}>
                            Mark accepted
                          </button>
                        )}
                        {offer.status !== "Declined" && (
                          <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => updateGigOffer(g.id, offer.id, "Declined"))}>
                            Mark declined
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        <div className="modal-foot">
          <span className="muted">Changes save as you go.</span>
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
