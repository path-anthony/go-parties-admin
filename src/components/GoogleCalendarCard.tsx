import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { disconnectGoogle, getGoogleCalendar, syncGoogleNow, updateGoogleCalendar } from "../lib/api";
import type { GoogleCalendarInfo } from "../lib/types";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : "");

// Google Calendar: connected once by a Workspace admin, then GO's events on
// GO's calendar and, when switched on, invites to customers from a separate
// calendar. One-way: the app writes to Google, never the reverse.
export function GoogleCalendarCard() {
  const [info, setInfo] = useState<GoogleCalendarInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  function load() {
    return getGoogleCalendar()
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the Google Calendar status"));
  }
  useEffect(() => {
    void load();
    const result = params.get("google");
    if (result) {
      setNotice(result);
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      if (done) setNotice(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  if (!info && !error) return <p className="muted">Loading…</p>;
  if (!info) return <p className="form-error">{error}</p>;
  const r = info.lastSyncResult;
  return (
    <div>
      {notice && <p className="bulk-result" role="status">{notice}</p>}
      {error && <p className="form-error">{error}</p>}
      {info.configProblem && <p className="stage-warning">{info.configProblem}</p>}
      {!info.connected && (
        <div>
          <p className="muted settings-help">
            Connect once as a Google Workspace admin (info@thegoeventgroup.com). GO gets a calendar event for every booking that reaches the stage you choose, and customers can get a calendar invite.
            The app writes to Google; it never reads changes back.
          </p>
          <a className={`btn-primary${info.configProblem ? " disabled" : ""}`} href={info.configProblem ? undefined : "/api/integrations/google/start"} aria-disabled={!!info.configProblem}>
            Connect with Google
          </a>
        </div>
      )}
      {info.connected && (
        <div className="add-item-form">
          <p>
            <strong>Connected as {info.email ?? "a Google account"}</strong>
            {info.connectedAt && <span className="muted"> · since {when(info.connectedAt)}</span>}
          </p>
          {info.needsReconnect && (
            <p className="stage-warning" role="alert">
              Reconnect needed: Google no longer accepts this connection (access was revoked or expired). Nothing syncs until you connect again.{" "}
              <a className="btn-secondary" href="/api/integrations/google/start">
                Reconnect
              </a>
            </p>
          )}
          {info.calendarError && <p className="form-error">Couldn't list the calendars: {info.calendarError}</p>}
          <div className="field-row">
            <label>
              GO's calendar
              <select value={info.calendarId ?? ""} disabled={busy} onChange={(e) => run(() => updateGoogleCalendar({ calendarId: e.target.value || null }), "Saved.")}>
                <option value="">Choose a calendar</option>
                {info.calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.summary}
                    {c.primary ? " (primary)" : ""}
                  </option>
                ))}
              </select>
              <span className="muted field-help">Where GO's own event for each booking goes. Internal: crew, contacts and the admin link. Never shared.</span>
            </label>
            <label>
              Customer invites calendar
              <select value={info.invitesCalendarId ?? ""} disabled={busy} onChange={(e) => run(() => updateGoogleCalendar({ invitesCalendarId: e.target.value || null }), "Saved.")}>
                <option value="">Choose a calendar</option>
                {info.calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.summary}
                  </option>
                ))}
              </select>
              <span className="muted field-help">A separate calendar (for example "GO Client Invites") the invites go out from. Customer-safe: services, GO's phone and email, their portal link.</span>
            </label>
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={info.sendInvites} disabled={busy || !info.invitesCalendarId} onChange={(e) => run(() => updateGoogleCalendar({ sendInvites: e.target.checked }), e.target.checked ? "Invites are on." : "Invites are off.")} />
            Send calendar invites to customers
          </label>
          <span className="muted field-help">
            Google emails the invite, every update and the cancellation to the customer's email on the booking, and keeps their own calendar in step. Needs an invites calendar chosen.
          </span>
          <label>
            Add bookings when they are
            <select value={info.syncStage} disabled={busy} onChange={(e) => run(() => updateGoogleCalendar({ syncStage: e.target.value as "Confirmed" | "Signed" }), "Saved.")}>
              <option value="Confirmed">Confirmed (signed and retainer paid)</option>
              <option value="Signed">Signed</option>
            </select>
            <span className="muted field-help">A booking that falls below this (cancelled, released, or moved back) loses its events; the customer gets Google's cancellation.</span>
          </label>
          <div className="form-actions">
            <button type="button" className="btn-primary" disabled={busy || info.needsReconnect} onClick={() => run(() => syncGoogleNow(), "Sync finished.")}>
              {busy ? "Working…" : "Sync now"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Disconnect Google Calendar? Events already on the calendars stay as they are, but nothing syncs until you connect again.")) void run(() => disconnectGoogle(), "Disconnected.");
              }}
            >
              Disconnect
            </button>
          </div>
          <p className="muted">
            Last sync: {info.lastSyncAt ? `${when(info.lastSyncAt)} ET` : "never"}
            {r && ` · ${r.checked} checked, ${r.created} created, ${r.updated} updated, ${r.deleted} removed, ${r.unchanged} unchanged${r.failed ? `, ${r.failed} failed` : ""}`}
          </p>
          {r && r.errors.length > 0 && (
            <ul className="addon-list">
              {r.errors.map((e, i) => (
                <li key={i} className="form-error">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
