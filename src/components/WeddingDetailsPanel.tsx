import { type FormEvent, useCallback, useEffect, useState } from "react";
import { getWeddingDetails, setWeddingOverride, unlockWeddingDetails, weddingPrintUrl } from "../lib/api";
import type { WeddingStaffView } from "../lib/types";

const STATUS: Record<string, string> = { not_started: "Not started", in_progress: "In progress", submitted: "Submitted" };
const CHIP: Record<string, string> = { not_started: "achip-none", in_progress: "achip-unchecked", submitted: "achip-yes" };
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

type Choice = "auto" | "on" | "off";
const toChoice = (v: boolean | null): Choice => (v === null ? "auto" : v ? "on" : "off");
const fromChoice = (c: Choice): boolean | null => (c === "auto" ? null : c === "on");

// Block A11. The wedding details on a booking: whether it counts as a
// wedding, where the customer has got to, what they answered, a print page,
// and opening a submitted form for changes.
export function WeddingDetailsPanel({ bookingId, onChanged }: { bookingId: string; onChanged?: () => void }) {
  const [view, setView] = useState<WeddingStaffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(() => {
    getWeddingDetails(bookingId)
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the wedding details"));
  }, [bookingId]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<WeddingStaffView>) {
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

  function submitUnlock(e: FormEvent) {
    e.preventDefault();
    void act(() => unlockWeddingDetails(bookingId, reason)).then(() => {
      setUnlocking(false);
      setReason("");
    });
  }

  function print() {
    const w = window.open(weddingPrintUrl(bookingId), "_blank");
    w?.addEventListener("load", () => w.print());
  }

  if (!view) return error ? <span className="form-error">{error}</span> : null;
  const d = view.details;
  return (
    <div className="status-control" role="group" aria-label="Wedding details">
      <span className="status-now">
        <span className="detail-field-label">Wedding details</span>
        {d && <span className={`achip ${CHIP[d.status]}`}>{STATUS[d.status]}</span>}
      </span>
      {error && <span className="form-error">{error}</span>}
      <label>
        <span className="detail-field-label">Is this a wedding?</span>
        <select value={toChoice(view.weddingOverride)} disabled={busy} onChange={(e) => void act(() => setWeddingOverride(bookingId, fromChoice(e.target.value as Choice)))}>
          <option value="auto">Automatic ({view.automatic ? "yes" : "no"}, from the occasion and package)</option>
          <option value="on">Yes, this is a wedding</option>
          <option value="off">No, not a wedding</option>
        </select>
      </label>
      {d && (
        <>
          <span className="muted field-help">
            {d.requiredDone} of {d.requiredTotal} required sections · due {day(d.dueDate)}
            {d.submittedAt ? ` · submitted ${when(d.submittedAt)} ET${d.submittedBy ? ` by ${d.submittedBy}` : ""}` : ""}
          </span>
          {d.changeRequestedAt && (
            <p className="stage-warning" role="note">
              <strong>Change requested {when(d.changeRequestedAt)} ET.</strong> {d.changeRequestNote ?? "No note."}
            </p>
          )}
          {d.unlockedAt && !d.submittedAt && (
            <span className="muted field-help">
              Opened for changes {when(d.unlockedAt)} ET: {d.unlockReason}
            </span>
          )}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={print}>
              Print
            </button>
            {d.status === "submitted" && !unlocking && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setUnlocking(true)}>
                Unlock for changes
              </button>
            )}
          </div>
          {unlocking && (
            <form className="add-item-form" onSubmit={submitUnlock}>
              <label>
                Why are these details being opened?
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required disabled={busy} autoFocus />
              </label>
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={busy || reason.trim() === ""}>
                  Unlock
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setUnlocking(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          <details className="wedding-answers">
            <summary>Answers</summary>
            {d.sections
              .filter((s) => s.rows.length > 0)
              .map((s) => (
                <section key={s.key} className="wedding-section">
                  <h4>
                    {s.number}. {s.title}
                  </h4>
                  <ul>
                    {s.rows.map((r, i) => (
                      <li key={`${r.group ?? ""}${r.label}${i}`}>
                        {r.group && <span className="muted">{r.group}: </span>}
                        {r.value === null ? (
                          r.label
                        ) : (
                          <>
                            <span className="muted">{r.label}: </span>
                            <span className="wedding-value">{r.value}</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            {d.sections.every((s) => s.rows.length === 0) && <p className="muted">Nothing filled in yet.</p>}
          </details>
        </>
      )}
    </div>
  );
}
