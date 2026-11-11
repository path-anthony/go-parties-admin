import { type FormEvent, useEffect, useState } from "react";
import { getBookingPayments, recordPayment } from "../lib/api";
import type { PaymentsView } from "../lib/types";

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

const STATUS: Record<string, string> = {
  pending: "Started, not paid",
  processing: "Processing",
  succeeded: "Paid",
  failed: "Failed",
  expired: "Expired",
  refunded: "Refunded",
  disputed: "Disputed",
};

// Block T1. Money on a booking: what came in, what is still due, and a cash
// or check payment recorded by hand. Block F1: this app sends no money out,
// so there is no refund button; a refund is made in Stripe and written in the
// refund log (MoneyControls).
export function PaymentsSection({ bookingId, onChanged }: { bookingId: string; onChanged?: () => void }) {
  const [view, setView] = useState<PaymentsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [kind, setKind] = useState<"retainer" | "balance" | "other">("retainer");
  const [method, setMethod] = useState<"cash" | "check" | "other">("cash");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const refresh = () =>
    getBookingPayments(bookingId)
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the payments"));
  useEffect(() => {
    void refresh();
  }, [bookingId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn: () => Promise<PaymentsView>) {
    setBusy(true);
    setError(null);
    try {
      setView(await fn());
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save");
    } finally {
      setBusy(false);
    }
  }

  function submitRecord(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError("Enter the amount in dollars.");
      return;
    }
    void act(() => recordPayment(bookingId, { kind, amountCents: cents, method, note: note.trim() || null })).then(() => {
      setRecording(false);
      setAmount("");
      setNote("");
    });
  }

  const m = view?.money;
  return (
    <div className="status-control" role="group" aria-label="Payments">
      <span className="status-now">
        <span className="detail-field-label">Payments</span>
        {view && (
          <span className={`achip ${m && m.totalCents !== null && m.balanceDueCents === 0 ? "achip-yes" : m?.retainerPaid ? "achip-unchecked" : "achip-none"}`}>
            {m && m.totalCents !== null ? `${usd(m.paidCents)} paid, ${usd(m.balanceDueCents ?? 0)} due` : "No total on this booking"}
          </span>
        )}
      </span>
      {error && <span className="form-error">{error}</span>}
      {view?.disputeFlaggedAt && (
        <p className="stage-warning" role="alert">
          <strong>Disputed.</strong> {view.disputeNote ?? "A payment on this booking was disputed with the card company."} Flagged {when(view.disputeFlaggedAt)} ET.
        </p>
      )}
      {view && m && m.retainerDueCents !== null && (
        <span className="muted field-help">
          Retainer {usd(m.retainerDueCents)} {m.retainerPaid ? "paid" : `(${usd(m.retainerPaidCents)} so far)`}
          {m.totalCents !== null ? ` · total ${usd(m.totalCents)}` : ""}
          {view.stripeConfigured ? ` · online payment ${view.stripeMode === "live" ? "live" : "in test mode"}` : " · online payment not set up"}
        </span>
      )}
      {view && view.payments.length > 0 && (
        <ul className="addon-list">
          {view.payments.map((p) => (
            <li key={p.id} className="unit-row">
              <span>
                <strong>{usd(p.amountCents)}</strong> {p.kind} · {p.method}
                {p.refundedCents > 0 ? ` · ${usd(p.refundedCents)} refunded` : ""}
                {p.recordedByName ? ` · recorded by ${p.recordedByName}` : ""}
                {p.note ? <span className="muted"> · {p.note}</span> : null}
                {p.failureReason ? <span className="form-error"> · {p.failureReason}</span> : null}
              </span>
              <span>
                <span className={`msg-status ${p.status === "succeeded" ? "msg-sent" : p.status === "failed" || p.status === "disputed" ? "msg-failed" : "msg-skipped"}`}>{STATUS[p.status] ?? p.status}</span>
                {p.paidAt ? <span className="muted"> {when(p.paidAt)} ET</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {view && view.payments.length === 0 && <span className="muted">No payments yet.</span>}

      {!recording && (
        <button type="button" className="btn-secondary" disabled={busy || !view} onClick={() => setRecording(true)}>
          Record a payment
        </button>
      )}
      {recording && (
        <form className="add-item-form" onSubmit={submitRecord}>
          <div className="field-row">
            <label>
              What
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} disabled={busy}>
                <option value="retainer">Retainer</option>
                <option value="balance">Balance</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              How
              <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} disabled={busy}>
                <option value="cash">Cash</option>
                <option value="check">Check</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Amount ($)
              <input type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} required />
            </label>
          </div>
          <label>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Check number, who took it" disabled={busy} />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Saving…" : "Save payment"}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setRecording(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

    </div>
  );
}
