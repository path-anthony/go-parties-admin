import { type FormEvent, useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/api";

// Who is told when a contract is signed, and how far ahead of an event the
// balance reminder check looks. A blank contact is fine: that message is
// logged as skipped.
export function NotificationSettings() {
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const snap = (p: string, e: string, d: string) => JSON.stringify([p, e, d]);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setPhone(s.staffNotifyPhone ?? "");
        setEmail(s.staffNotifyEmail ?? "");
        setDays(String(s.balanceReminderWindowDays));
        setSaved(snap(s.staffNotifyPhone ?? "", s.staffNotifyEmail ?? "", String(s.balanceReminderWindowDays)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the settings"));
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const s = await updateSettings({
        staffNotifyPhone: phone.trim() === "" ? null : phone,
        staffNotifyEmail: email.trim() === "" ? null : email,
        balanceReminderWindowDays: Number(days),
      });
      setPhone(s.staffNotifyPhone ?? "");
      setEmail(s.staffNotifyEmail ?? "");
      setDays(String(s.balanceReminderWindowDays));
      setSaved(snap(s.staffNotifyPhone ?? "", s.staffNotifyEmail ?? "", String(s.balanceReminderWindowDays)));
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const ready = saved !== null;
  const dirty = ready && saved !== snap(phone, email, days);
  return (
    <form onSubmit={handleSave} className="add-item-form">
      <div className="field-row">
        <label>
          Staff notification phone
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(860) 555-0100" disabled={!ready || busy} maxLength={200} />
          <span className="muted field-help">Gets a text when a customer signs a contract.</span>
        </label>
        <label>
          Staff notification email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="andy@example.com" disabled={!ready || busy} maxLength={200} />
          <span className="muted field-help">Gets the signed contract link by email, through the email webhook.</span>
        </label>
        <label>
          Balance reminder window (days)
          <input type="number" min={0} max={120} step={1} value={days} onChange={(e) => setDays(e.target.value)} disabled={!ready || busy} required />
          <span className="muted field-help">The reminder check looks at events starting within this many days. Nothing runs it on a schedule yet.</span>
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
