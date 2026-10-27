import { type FormEvent, useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/api";

// Block T1. Which agreement a booking needs, and what checkout collects.
// Review rules (above on the page) decide tier 3 first; then a contract is
// required over this total or for any crewed item (tier 2); everything else
// is the rental policy checkbox (tier 1).
export function TierSettings() {
  const [over, setOver] = useState("");
  const [crewed, setCrewed] = useState(true);
  const [releaseDays, setReleaseDays] = useState("");
  const [collect, setCollect] = useState<"retainer" | "full">("retainer");
  const [saveCard, setSaveCard] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const snapshot = (o: string, c: boolean, r: string, col: string, s: boolean) => JSON.stringify([o, c, r, col, s]);
  const load = (s: { contractRequiredOver: number; contractRequiredForCrewed: boolean; contractHoldReleaseDays: number; tier1Collect: "retainer" | "full"; saveCardForBalance: boolean }) => {
    setOver(String(s.contractRequiredOver));
    setCrewed(s.contractRequiredForCrewed);
    setReleaseDays(String(s.contractHoldReleaseDays));
    setCollect(s.tier1Collect);
    setSaveCard(s.saveCardForBalance);
    setSaved(snapshot(String(s.contractRequiredOver), s.contractRequiredForCrewed, String(s.contractHoldReleaseDays), s.tier1Collect, s.saveCardForBalance));
  };

  useEffect(() => {
    getSettings()
      .then(load)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the settings"));
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      load(await updateSettings({ contractRequiredOver: Number(over), contractRequiredForCrewed: crewed, contractHoldReleaseDays: Number(releaseDays), tier1Collect: collect, saveCardForBalance: saveCard }));
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const ready = saved !== null;
  const dirty = ready && saved !== snapshot(over, crewed, releaseDays, collect, saveCard);

  return (
    <form onSubmit={handleSave} className="add-item-form">
      <div className="field-row">
        <label>
          Contract required over ($)
          <input type="number" min={0} step="0.01" value={over} onChange={(e) => setOver(e.target.value)} disabled={!ready || busy} required />
          <span className="muted field-help">A cart with a total over this amount signs the GO contract in checkout (tier 2). Exactly this amount does not.</span>
        </label>
        <label>
          Release unpaid contract holds after (days)
          <input type="number" min={0} max={365} step={1} value={releaseDays} onChange={(e) => setReleaseDays(e.target.value)} disabled={!ready || busy} required />
          <span className="muted field-help">A contract signed in checkout whose retainer is still unpaid after this many days is released by the hourly check. 0 never releases.</span>
        </label>
      </div>
      <label className="checkbox-label">
        <input type="checkbox" checked={crewed} onChange={(e) => setCrewed(e.target.checked)} disabled={!ready || busy} />
        Always require a contract for crewed items
      </label>
      <span className="muted field-help">Any item that needs crew (a DJ, a photographer) takes the contract whatever the total.</span>

      <div className="field-row">
        <label>
          Small rentals (tier 1) collect
          <select value={collect} onChange={(e) => setCollect(e.target.value as "retainer" | "full")} disabled={!ready || busy}>
            <option value="retainer">The retainer percent</option>
            <option value="full">The full amount</option>
          </select>
          <span className="muted field-help">What a rental-policy booking pays in checkout. The retainer percent is set above.</span>
        </label>
      </div>
      <label className="checkbox-label">
        <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} disabled={!ready || busy} />
        Save the card for the balance
      </label>
      <span className="muted field-help">When on, Stripe keeps the card from the retainer payment for an off-session balance charge later. Nothing charges automatically yet.</span>

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
