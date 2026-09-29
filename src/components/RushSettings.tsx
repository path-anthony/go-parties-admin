import { type FormEvent, useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/api";

// Minimum booking notice and the rush contact phone. Explicit Save, since
// changing the hours changes what the next booking is flagged as.
export function RushSettings() {
  const [hours, setHours] = useState("");
  const [phone, setPhone] = useState("");
  const [saved, setSaved] = useState<{ hours: string; phone: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setHours(String(s.minBookingNoticeHours));
        setPhone(s.rushContactPhone ?? "");
        setSaved({ hours: String(s.minBookingNoticeHours), phone: s.rushContactPhone ?? "" });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the settings"));
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const s = await updateSettings({ minBookingNoticeHours: Number(hours), rushContactPhone: phone.trim() === "" ? null : phone });
      setHours(String(s.minBookingNoticeHours));
      setPhone(s.rushContactPhone ?? "");
      setSaved({ hours: String(s.minBookingNoticeHours), phone: s.rushContactPhone ?? "" });
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const dirty = saved !== null && (saved.hours !== hours || saved.phone !== phone);

  return (
    <form onSubmit={handleSave} className="add-item-form">
      <div className="field-row">
        <label>
          Minimum booking notice (hours)
          <input type="number" min={0} step={1} value={hours} onChange={(e) => setHours(e.target.value)} disabled={saved === null || busy} required />
          <span className="muted field-help">
            A booking whose event day starts sooner than this from now is flagged RUSH. It still completes normally. 0 turns
            the flag off.
          </span>
        </label>
        <label>
          Rush order contact phone
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Not set yet, e.g. (860) 555-0100"
            maxLength={40}
            disabled={saved === null || busy}
          />
          <span className="muted field-help">Shown to a customer booking inside that window. Blank until a real number is set.</span>
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
