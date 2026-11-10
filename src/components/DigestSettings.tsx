import { type FormEvent, useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/api";

// The morning email of unread notifications: where it goes, and on or off.
export function DigestSettings() {
  const [email, setEmail] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const snap = (e: string, on: boolean) => JSON.stringify([e, on]);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setEmail(s.digestEmail);
        setEnabled(s.digestEnabled);
        setSaved(snap(s.digestEmail, s.digestEnabled));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the settings"));
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const s = await updateSettings({ digestEmail: email, digestEnabled: enabled });
      setEmail(s.digestEmail);
      setEnabled(s.digestEnabled);
      setSaved(snap(s.digestEmail, s.digestEnabled));
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const ready = saved !== null;
  const dirty = ready && saved !== snap(email, enabled);
  return (
    <form onSubmit={handleSave} className="add-item-form">
      <label className="checkbox-label">
        <input type="checkbox" role="switch" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!ready || busy} />
        Send the daily digest
      </label>
      <div className="field-row">
        <label>
          Digest email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!ready || busy} maxLength={200} required />
          <span className="muted field-help">Gets one email each morning at 7 AM Eastern when notifications from the last 24 hours are still unread.</span>
        </label>
      </div>
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
