import { useEffect, useState } from "react";
import { isInactiveStage } from "../lib/bookingStatus";
import { X } from "lucide-react";
import { getGig } from "../lib/api";
import { formatEventDay, gigPillClass } from "../lib/gigs";
import type { Gig, GigDetail } from "../lib/types";
import { AutomationTimeline } from "./AutomationTimeline";
import { BidsPanel } from "./BidsPanel";
import { RecordMessages } from "./RecordMessages";
import { AgreementChip } from "./AgreementChip";
import { BookingStatusTag } from "./BookingStatusTag";
import { RushTag } from "./RushTag";

// One gig: where it came from, the details crew see, who was invited to bid,
// each bid, and the pick.
export function GigModal({ gig: summary, onClose, onChanged }: { gig: Gig; onClose: () => void; onChanged: (gig: Gig) => void }) {
  const [gig, setGig] = useState<GigDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getGig(summary.id)
      .then((detail) => {
        if (!alive) return;
        setGig(detail);
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
              {g.booking.customerName} <BookingStatusTag booking={g.booking} /> <AgreementChip agreement={g.booking.agreement} />
              <RushTag rush={g.booking.rush} cancelled={isInactiveStage(g.booking.status)} />
            </span>
          </div>
          <div className="detail-field">
            <span className="detail-field-label">Filled by</span>
            <span className={g.filledBy ? "" : "muted"}>{g.filledBy?.name ?? "Nobody yet"}</span>
          </div>
        </div>

        <RecordMessages gigId={g.id} />
        <AutomationTimeline kind="gig" id={g.id} />

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
            {gig ? <BidsPanel gig={gig} busy={busy} run={run} setNotice={setNotice} /> : !error && <p className="muted">Loading…</p>}
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
