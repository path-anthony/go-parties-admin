import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getBookings, getDesignRequests, getUnits, updateDesignRequest } from "../../lib/api";
import { formatEventDay } from "../../lib/gigs";
import type { DesignRequest } from "../../lib/types";
import { NewBookingModal } from "../NewBookingModal";
import { useNavigate } from "../../lib/navigation";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const STATUSES = ["Open", "Converted", "Dismissed"] as const;
// Requests made before Block F2 carry only these; newer ones carry the exact
// rule in reviewReason ("Wedding total is $5,000 or more").
const REASON_TEXT = { threshold: "Total is at or over the review amount", occasion: "Occasion was on the old review list" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

// Block F2: dismissing asks why, and can tell the customer by email. The
// email's wording is the "Request closed" template in Messages, Templates.
function DismissForm({ request, busy, onDismiss, onCancel }: { request: DesignRequest; busy: boolean; onDismiss: (reason: string, tellCustomer: boolean) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const [tell, setTell] = useState(false);
  return (
    <form
      className="add-item-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim() !== "") onDismiss(reason.trim(), tell);
      }}
    >
      <label>
        Why is this request being dismissed?
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required disabled={busy} autoFocus placeholder="Out of our area, date not available, duplicate" />
        <span className="muted field-help">For your team only. The customer never sees this.</span>
      </label>
      <label className="checkbox-label">
        <input type="checkbox" checked={tell} disabled={busy || !request.email} onChange={(e) => setTell(e.target.checked)} />
        Tell the customer by email
      </label>
      <span className="muted field-help">
        {request.email ? `Sends the "Request closed" email to ${request.email}. Edit its wording in Messages, Templates.` : "There is no email address on this request, so nothing can be sent."}
      </span>
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={busy || reason.trim() === ""}>
          Dismiss request
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Staff notes on one request: what was said on the call, what to quote, who
// is handling it. Saved with the button; nothing is sent to the customer.
function RequestNotes({ value, disabled, onSave }: { value: string | null; disabled: boolean; onSave: (notes: string | null) => void }) {
  const [text, setText] = useState(value ?? "");
  const dirty = text.trim() !== (value ?? "").trim();
  return (
    <label className="detail-field request-notes">
      <span className="detail-field-label">Staff notes (not shown to the customer)</span>
      <textarea rows={2} maxLength={2000} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} placeholder="What was discussed, what to quote, who is handling it" />
      {dirty && (
        <span className="form-actions">
          <button type="button" className="btn-secondary" disabled={disabled} onClick={() => onSave(text.trim() === "" ? null : text.trim())}>
            Save notes
          </button>
          <button type="button" className="link-button" disabled={disabled} onClick={() => setText(value ?? "")}>
            Undo
          </button>
        </span>
      )}
    </label>
  );
}

// The review queue: carts that were routed here instead of being held,
// because the total is over the threshold or the occasion is on the
// review list. Nothing on them is locked. Converting one opens New
// booking pre-filled from it, so the same availability, locks and
// agreement rule apply, and staff can change anything (price included)
// before it becomes a real Held booking.
export function DesignRequestsScreen() {
  const navigate = useNavigate();
  // The status filter lives in the address (?status=Converted), so a filtered
  // view can be bookmarked. Choosing the one already showing changes nothing.
  const [params, setParams] = useSearchParams();
  const wanted = params.get("status");
  const status: (typeof STATUSES)[number] = STATUSES.find((s) => s === wanted) ?? "Open";
  const setStatus = (next: (typeof STATUSES)[number]) => {
    if (next !== status) setParams({ status: next }, { replace: true });
  };
  const [requests, setRequests] = useState<DesignRequest[] | null>(null);
  // Which tab the list on screen was loaded for. The screen is loading
  // whenever that differs from the tab selected, so clicking the tab that
  // is already selected changes nothing (no reset, no hang).
  const [loadedStatus, setLoadedStatus] = useState<(typeof STATUSES)[number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState<DesignRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

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

  async function change(id: string, patch: { status?: "Open" | "Dismissed"; notes?: string | null; reason?: string; tellCustomer?: boolean }) {
    setBusyId(id);
    setError(null);
    try {
      const saved = await updateDesignRequest(id, patch);
      if (patch.status === "Dismissed") {
        setDismissingId(null);
        setNotice(saved.customerTold ? (saved.customerTold.sent ? `Dismissed. ${saved.customerName} was told by email.` : `Dismissed. The email did not go: ${saved.customerTold.why}`) : `Dismissed. ${saved.customerName} was not told.`);
      }
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
          Orders that need a person before anything is held: the total is at or over the review amount for the occasion
          (Settings, Booking rules, Review rules). Nothing is locked on a request. A customer who sends one from the store
          is told a person will be in touch within the number of business days set there, and can see the request in their account.
        </p>
      </div>

      <section className="panel">
        <div className="filter-row" role="group" aria-label="Show requests">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
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
              {r.reviewReason ? (
                <span className="reason-pill">{r.reviewReason}</span>
              ) : (
                r.reasons.map((reason) => (
                  <span key={reason} className="reason-pill">
                    {REASON_TEXT[reason]}
                  </span>
                ))
              )}
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
            {r.address && (
              <div className="muted">
                At {r.address}
                {r.placeId ? " (exact address, from Google)" : ""}
                {r.eventAddressSameAsHome ? " · same as their home address" : ""}
                {r.mapsUrl && (
                  <>
                    {" · "}
                    <a href={r.mapsUrl} target="_blank" rel="noreferrer">
                      Open in Google Maps
                    </a>
                  </>
                )}
              </div>
            )}
            {r.setupNotes && (
              <div>
                <span className="detail-field-label">Setup notes from the customer</span> {r.setupNotes}
              </div>
            )}
            {r.setupLat !== null && r.setupLng !== null && (
              <div className="muted">
                Setup pin:{" "}
                <a href={`https://www.google.com/maps/search/?api=1&query=${r.setupLat.toFixed(6)},${r.setupLng.toFixed(6)}`} target="_blank" rel="noreferrer">
                  {r.setupLat.toFixed(5)}, {r.setupLng.toFixed(5)}
                </a>
              </div>
            )}
            {r.guestCount !== null && <div className="muted">Guests: {r.guestCount}</div>}
            {r.status === "Dismissed" && r.dismissReason && (
              <div className="muted">
                Dismissed{r.dismissedByName ? ` by ${r.dismissedByName}` : ""}
                {r.dismissedAt ? `, ${when(r.dismissedAt)} ET` : ""}: {r.dismissReason}. {r.customerToldAt ? `The customer was told by email ${when(r.customerToldAt)} ET.` : "The customer was not told."}
              </div>
            )}
            <RequestNotes key={`${r.id}:${r.notes ?? ""}`} value={r.notes} disabled={busyId === r.id} onSave={(notes) => change(r.id, { notes })} />
            <div className="form-actions">
              {r.status === "Open" && (
                <>
                  <button type="button" className="btn-primary" onClick={() => setConverting(r)} disabled={busyId === r.id}>
                    Convert to booking
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setDismissingId(dismissingId === r.id ? null : r.id)} disabled={busyId === r.id} aria-expanded={dismissingId === r.id}>
                    Dismiss
                  </button>
                </>
              )}
              {r.status === "Open" && dismissingId === r.id && (
                <DismissForm request={r} busy={busyId === r.id} onCancel={() => setDismissingId(null)} onDismiss={(reason, tellCustomer) => change(r.id, { status: "Dismissed", reason, tellCustomer })} />
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
            setNotice(`Turned ${converting.customerName}'s request into a booking. It is in Scheduling. Its setup notes, pin and guest count went with it.`);
            await reload();
          }}
          onReview={() => setConverting(null)}
        />
      )}
    </div>
  );
}
