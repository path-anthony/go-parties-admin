import { type FormEvent, useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/api";
import { OCCASION_GROUPS } from "../lib/occasions";

// Review routing and the deposit. A cart over the threshold, or one for an
// occasion that is ticked here, goes to the Design Requests queue instead
// of becoming a Held booking. Ticking a group (Wedding) covers everything
// in it; a single sub-occasion can be ticked on its own.
export function ReviewSettings() {
  const [threshold, setThreshold] = useState("");
  const [occasions, setOccasions] = useState<string[]>([]);
  const [deposit, setDeposit] = useState("");
  const [requireBox, setRequireBox] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const snapshot = (t: string, o: string[], d: string, r: boolean) => JSON.stringify([t, [...o].sort(), d, r]);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setThreshold(String(s.fullReviewThreshold));
        setOccasions(s.reviewOccasions);
        setDeposit(String(s.depositPercentage));
        setRequireBox(s.requireAgreementCheckbox);
        setSaved(snapshot(String(s.fullReviewThreshold), s.reviewOccasions, String(s.depositPercentage), s.requireAgreementCheckbox));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the settings"));
  }, []);

  function toggle(value: string, on: boolean) {
    setOccasions((prev) => (on ? [...new Set([...prev, value])] : prev.filter((o) => o !== value)));
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const s = await updateSettings({
        fullReviewThreshold: Number(threshold),
        reviewOccasions: occasions,
        depositPercentage: Number(deposit),
        requireAgreementCheckbox: requireBox,
      });
      setThreshold(String(s.fullReviewThreshold));
      setOccasions(s.reviewOccasions);
      setDeposit(String(s.depositPercentage));
      setRequireBox(s.requireAgreementCheckbox);
      setSaved(snapshot(String(s.fullReviewThreshold), s.reviewOccasions, String(s.depositPercentage), s.requireAgreementCheckbox));
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const ready = saved !== null;
  const dirty = ready && saved !== snapshot(threshold, occasions, deposit, requireBox);

  return (
    <form onSubmit={handleSave} className="add-item-form">
      <div className="field-row">
        <label>
          Full review threshold ($)
          <input type="number" min={0} step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={!ready || busy} required />
          <span className="muted field-help">A booking with a total over this amount goes to Design Requests. Exactly this amount does not.</span>
        </label>
        <label>
          Deposit percentage (%)
          <input type="number" min={0} max={100} step="0.01" value={deposit} onChange={(e) => setDeposit(e.target.value)} disabled={!ready || busy} required />
          <span className="muted field-help">One value for every booking for now. Recorded only; nothing is charged yet.</span>
        </label>
      </div>

      <div className="detail-field">
        <span className="detail-field-label">Occasions requiring review</span>
        <div className="occasion-review-grid" role="group" aria-label="Occasions requiring review">
          {OCCASION_GROUPS.map((group) => (
            <div key={group.label} className="occasion-group">
              <label className="checkbox-label">
                <input type="checkbox" checked={occasions.includes(group.label)} onChange={(e) => toggle(group.label, e.target.checked)} disabled={!ready || busy} />
                <strong>{group.label}</strong> <span className="muted">(all of it)</span>
              </label>
              <div className="skill-grid">
                {group.occasions.map((occ) => (
                  <label key={occ} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={occasions.includes(occ) || occasions.includes(group.label)}
                      onChange={(e) => toggle(occ, e.target.checked)}
                      disabled={!ready || busy || occasions.includes(group.label)}
                    />
                    {occ}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <span className="muted field-help">A booking for a ticked occasion, whatever the price, goes to Design Requests.</span>
      </div>

      <label className="checkbox-label">
        <input type="checkbox" checked={requireBox} onChange={(e) => setRequireBox(e.target.checked)} disabled={!ready || busy} />
        Require the agreement checkbox on storefront bookings
      </label>
      <span className="muted field-help">
        Turn this on once the storefront shows the policy and sends the ticked box. While it is off, a storefront booking without it is
        still recorded, marked "box not ticked".
      </span>

      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {message && <span className="muted">{message}</span>}
        {error && <span className="form-error">{error}</span>}
      </div>
    </form>
  );
}
