import { type FormEvent, useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/api";

// Limits that protect the storefront's public forms from running up costs or
// filling the calendar with junk. All counted per day, Eastern, and kept in
// the database so a deploy does not reset them.
export function SafetySettings() {
  const [ai, setAi] = useState("");
  const [bookings, setBookings] = useState("");
  const [hold, setHold] = useState("");
  const [bot, setBot] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const snap = (a: string, b: string, h: string, r: boolean) => JSON.stringify([a, b, h, r]);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setAi(String(s.aiDailyCap));
        setBookings(String(s.directBookingDailyCap));
        setHold(String(s.holdReleaseDays));
        setBot(s.requireBotCheck);
        setSaved(snap(String(s.aiDailyCap), String(s.directBookingDailyCap), String(s.holdReleaseDays), s.requireBotCheck));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the settings"));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const s = await updateSettings({ aiDailyCap: Number(ai), directBookingDailyCap: Number(bookings), holdReleaseDays: Number(hold), requireBotCheck: bot });
      setSaved(snap(String(s.aiDailyCap), String(s.directBookingDailyCap), String(s.holdReleaseDays), s.requireBotCheck));
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const ready = saved !== null;
  const dirty = ready && saved !== snap(ai, bookings, hold, bot);

  return (
    <form onSubmit={save} className="add-item-form">
      <div className="field-row">
        <label>
          Ask GO messages per day (public)
          <input type="number" min={0} max={100000} step={1} value={ai} onChange={(e) => setAi(e.target.value)} disabled={!ready || busy} required />
          <span className="muted field-help">
            The most Ask GO replies the public can use in a day, all visitors together. Each reply costs real money. Over the limit, Ask GO says it is resting
            and asks people to call or text. Staff using Ask GO or suggesting package keywords do not count and are never blocked. Resets at midnight Eastern.
          </span>
        </label>
        <label>
          Storefront bookings per day
          <input type="number" min={0} max={10000} step={1} value={bookings} onChange={(e) => setBookings(e.target.value)} disabled={!ready || busy} required />
          <span className="muted field-help">The most bookings the public storefront can make in a day, all visitors together. Over it, customers are asked to call or text. Bookings staff make are never limited.</span>
        </label>
      </div>
      <div className="field-row">
        <label>
          Release unpaid storefront holds after (days)
          <input type="number" min={0} max={365} step={1} value={hold} onChange={(e) => setHold(e.target.value)} disabled={!ready || busy} required />
          <span className="muted field-help">
            0 means never. Otherwise a date a customer held on the storefront, still at Held with no retainer paid, is released after this many days: the items
            free up and the booking is marked Released. Bookings staff made are never touched. Checked every hour.
          </span>
        </label>
      </div>
      <label className="checkbox-label">
        <input type="checkbox" checked={bot} onChange={(e) => setBot(e.target.checked)} disabled={!ready || busy} />
        Require bot check fields on the public forms
      </label>
      <span className="muted field-help">
        The storefront sends a hidden field and a form start time with every public form. A filled hidden field, or a form finished in under 3 seconds, is always refused.
        Turning this on also refuses forms that do not send them at all. Turn it on only after the storefront that sends them is live.
      </span>
      {error && <p className="form-error">{error}</p>}
      {message && <p className="bulk-result">{message}</p>}
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
