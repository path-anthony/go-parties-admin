import { type FormEvent, useEffect, useState } from "react";
import { addRefund, decideCancellationRequest, getCancellationRequests, getPayLink, getRefunds, sendPayLink } from "../lib/api";
import type { CancellationRequestView, PayLinkView, RefundRecord } from "../lib/types";

// Block F1. The staff controls for the money path: Send pay link, the refund
// log, and a customer's cancellation request. Plain on purpose; the next
// block restyles the admin screens.

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const OWED: Record<PayLinkView["step"], string> = { sign: "retainer (after signing)", retainer: "retainer", balance: "balance", nothing: "", closed: "" };

// "Send pay link": sends whichever is owed, shows the amount before it goes
// and when it last went.
export function PayLinkControl({ bookingId, refreshKey, onSent }: { bookingId: string; refreshKey?: unknown; onSent?: () => void }) {
  const [view, setView] = useState<PayLinkView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let current = true;
    getPayLink(bookingId)
      .then((v) => current && setView(v))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bookingId, refreshKey]);

  async function send() {
    setBusy(true);
    setNote(null);
    try {
      const r = await sendPayLink(bookingId);
      setView(r);
      setNote(r.sent ? { ok: true, text: "Sent. It is in Messages, Sent log." } : { ok: false, text: `Not sent: ${r.why ?? "unknown reason"}.` });
      if (r.sent) onSent?.();
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : "That didn't send" });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!view) return null;
  const amount = view.amountCents !== null ? usd(view.amountCents) : "";
  const to = [view.hasPhone ? "text" : null, view.hasEmail ? "email" : null].filter(Boolean).join(" and ");
  return (
    <div className="status-control" role="group" aria-label="Pay link" data-testid="pay-link">
      <span className="status-now">
        <span className="detail-field-label">Pay link</span>
        <span className={`achip ${view.canSend ? "achip-unchecked" : "achip-yes"}`}>{view.canSend ? `${amount} ${OWED[view.step]} owed` : view.step === "closed" ? "Booking closed" : "Nothing owed"}</span>
      </span>
      <span className="muted field-help">
        {view.explain} {view.lastSentAt ? `Last sent ${when(view.lastSentAt)} ET${view.lastSentByName ? ` (${view.lastSentByName})` : ""}.` : "Not sent yet."}
      </span>
      {note && <span className={note.ok ? "muted" : "form-error"}>{note.text}</span>}
      {view.canSend && !confirming && (
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(true)}>
          Send pay link
        </button>
      )}
      {view.canSend && confirming && (
        <div className="add-item-form">
          <p className="stage-warning" role="note">
            {view.step === "sign"
              ? `This sends the contract link and tells the customer the retainer is ${amount}. The pay link follows as soon as they sign.`
              : `This sends the customer a link to pay the ${OWED[view.step]} of ${amount}.`}{" "}
            {to ? `It goes by ${to}.` : "There is no phone number or email on this booking, so it cannot go."} The customer pays on a secure Stripe page; nothing is charged by sending this.
          </p>
          <div className="form-actions">
            <button type="button" className="btn-primary" disabled={busy || !to} onClick={() => void send()}>
              {busy ? "Sending…" : `Send for ${amount}`}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <span className="muted field-help">
        The customer's own link: <a href={view.link}>{view.link}</a>
      </span>
    </div>
  );
}

const METHOD: Record<string, string> = { stripe: "Stripe (card)", check: "Check", cash: "Cash", other: "Other" };

// The refund log. A record only: saving a line here moves no money.
export function RefundLog({ bookingId, cancellationRequestId, initial }: { bookingId: string; cancellationRequestId?: string; initial?: RefundRecord[] }) {
  const [rows, setRows] = useState<RefundRecord[] | null>(initial ?? null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState("stripe");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (initial) return;
    let current = true;
    getRefunds(bookingId)
      .then((r) => current && setRows(r.refunds))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bookingId, initial]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return setError("Enter the amount refunded, in dollars.");
    setBusy(true);
    setError(null);
    try {
      const r = await addRefund(bookingId, { amountCents: cents, refundedOn: date, method, note: note.trim() || null, cancellationRequestId: cancellationRequestId ?? null });
      setRows(r.refunds);
      setAdding(false);
      setAmount("");
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="status-control" role="group" aria-label="Refund log" data-testid="refund-log">
      <span className="status-now">
        <span className="detail-field-label">Refund log</span>
        {rows && rows.length > 0 && <span className="achip achip-unchecked">{usd(rows.reduce((s, r) => s + r.amountCents, 0))} written down</span>}
      </span>
      <span className="muted field-help">A record only. The refund itself is made in Stripe (or by check or cash). Saving a line here sends no money and changes no payment.</span>
      {error && <span className="form-error">{error}</span>}
      {rows && rows.length > 0 && (
        <ul className="addon-list">
          {rows.map((r) => (
            <li key={r.id} className="unit-row">
              <span>
                <strong>{usd(r.amountCents)}</strong> · {METHOD[r.method] ?? r.method} · {day(r.refundedOn)}
                {r.note ? <span className="muted"> · {r.note}</span> : null}
              </span>
              <span className="muted">{r.recordedByName ? `written by ${r.recordedByName}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {!adding && (
        <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
          Write down a refund
        </button>
      )}
      {adding && (
        <form className="add-item-form" onSubmit={submit}>
          <div className="field-row">
            <label>
              Amount ($)
              <input type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} required />
            </label>
            <label>
              Date refunded
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} required />
            </label>
            <label>
              How
              <select value={method} onChange={(e) => setMethod(e.target.value)} disabled={busy}>
                {Object.entries(METHOD).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Why, and who agreed it" disabled={busy} />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Saving…" : "Save to the log"}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// A customer's cancellation requests on a lead: what they asked, what was
// paid, and Approve or Decline.
export function CancellationRequests({ leadId, onDecided }: { leadId: string; onDecided?: () => void }) {
  const [rows, setRows] = useState<CancellationRequestView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<{ id: string; decision: "approve" | "decline" } | null>(null);

  useEffect(() => {
    let current = true;
    getCancellationRequests({ leadId })
      .then((r) => current && setRows(r.requests))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [leadId]);

  async function decide(id: string, decision: "approve" | "decline") {
    setBusy(id);
    setError(null);
    try {
      const r = await decideCancellationRequest(id, decision, notes[id]?.trim() || null);
      setRows((all) => (all ?? []).map((x) => (x.id === id ? r.request : x)));
      if (!r.customerTold) setError("Saved, but the email to the customer did not go. Check Messages, Sent log, and tell them yourself.");
      onDecided?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save");
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  // Rows from another lead (the panel was switched) are never shown.
  if (!rows || rows.length === 0 || rows.some((r) => r.booking.leadId !== leadId)) return null;
  return (
    <section className="detail-section" aria-label="Cancellation requests" data-testid="cancellation-requests">
      <h3>Cancellation request</h3>
      {error && <p className="form-error">{error}</p>}
      {rows.map((r) => (
        <div key={r.id} className="status-control">
          <span className="status-now">
            <span className={`achip ${r.status === "Open" ? "achip-none" : r.status === "Approved" ? "achip-yes" : "achip-unchecked"}`}>{r.status === "Open" ? "Waiting for your decision" : r.status}</span>
            <span className="muted"> asked {when(r.createdAt)} ET</span>
          </span>
          <ul className="addon-list">
            <li>
              <strong>Booking:</strong> {r.booking.customerName}, {day(r.booking.eventDate)}
              {r.booking.eventTime ? `, ${r.booking.eventTime}` : ""} · stage {r.booking.status}
              {r.booking.totalCents !== null ? ` · total ${usd(r.booking.totalCents)}` : ""}
            </li>
            <li>
              <strong>Contact:</strong> {r.booking.phone ?? "no phone"} · {r.booking.email ?? "no email"}
            </li>
            <li>
              <strong>Paid:</strong> {usd(r.paidCents)}
              {r.retainerPaidCents > 0 ? ` (retainer ${usd(r.retainerPaidCents)})` : ""}
              {r.termsAcceptedAt ? `. They were shown the retainer terms and accepted them ${when(r.termsAcceptedAt)} ET.` : ". Nothing had been paid, so no terms were shown."}
            </li>
            <li>
              <strong>Their reason:</strong> {r.reason ?? "none given"}
            </li>
            {r.status !== "Open" && (
              <li>
                <strong>{r.status}</strong> {r.decidedAt ? when(r.decidedAt) : ""} ET{r.decidedByName ? ` by ${r.decidedByName}` : ""}
                {r.decisionNote ? `. Note: ${r.decisionNote}` : ""}. {r.customerToldAt ? "The customer was emailed." : "The customer was not emailed."}
              </li>
            )}
          </ul>
          {r.termsText && (
            <details>
              <summary>The terms they accepted</summary>
              <p className="muted" style={{ whiteSpace: "pre-wrap" }}>
                {r.termsText}
              </p>
            </details>
          )}
          {r.status === "Open" && (
            <>
              <span className="muted field-help">
                The booking and its date stay held until you decide. Approve cancels the booking, frees its items and emails the customer. Decline keeps the booking as it is and emails the customer. Neither one refunds anything: a refund is made
                in Stripe and written in the refund log below.
              </span>
              <label>
                Note for your records (not sent to the customer)
                <input value={notes[r.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} maxLength={500} disabled={busy === r.id} />
              </label>
              {confirming?.id !== r.id && (
                <div className="form-actions">
                  <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => setConfirming({ id: r.id, decision: "approve" })}>
                    Approve
                  </button>
                  <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => setConfirming({ id: r.id, decision: "decline" })}>
                    Decline
                  </button>
                </div>
              )}
              {confirming?.id === r.id && (
                <div className="add-item-form">
                  <p className="stage-warning" role="note">
                    {confirming.decision === "approve"
                      ? "Approve: the booking is cancelled now, its items and crew are freed, and the customer is emailed. This cannot be undone from here."
                      : "Decline: the booking stays exactly as it is, and the customer is emailed that it has not been cancelled."}
                  </p>
                  <div className="form-actions">
                    <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void decide(r.id, confirming.decision)}>
                      {busy === r.id ? "Saving…" : confirming.decision === "approve" ? "Yes, cancel the booking" : "Yes, keep the booking"}
                    </button>
                    <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => setConfirming(null)}>
                      Go back
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          <RefundLog bookingId={r.booking.id} cancellationRequestId={r.id} />
        </div>
      ))}
    </section>
  );
}
