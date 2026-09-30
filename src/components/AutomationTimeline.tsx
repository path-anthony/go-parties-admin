import { useEffect, useState } from "react";
import { getTimeline, setAutomationPaused, setSmsOptOut } from "../lib/api";
import type { Timeline, TimelineItem } from "../lib/types";

const STATE_LABEL: Record<TimelineItem["state"], string> = {
  sent: "Sent",
  scheduled: "Scheduled",
  due: "Going out now",
  skipped: "Skipped",
  blocked: "Blocked",
  stopped: "Stopped",
  paused: "Paused",
  waiting: "Waiting",
  failed_final: "Failed, gave up",
};

const STATE_CLASS: Record<TimelineItem["state"], string> = {
  sent: "msg-sent",
  scheduled: "msg-queued",
  due: "msg-queued",
  skipped: "msg-skipped",
  blocked: "msg-failed",
  stopped: "msg-skipped",
  paused: "msg-skipped",
  waiting: "msg-skipped",
  failed_final: "msg-failed",
};

const phoneText = (e164: string) => e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3");

// What the scheduler will do for one lead, booking or gig, from the same
// planner the sender uses, with the staff switch that pauses it. Only the
// timed messages are paused; texts sent when a stage changes are not.
export function AutomationTimeline({ kind, id }: { kind: "lead" | "booking" | "gig"; id: string }) {
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    return getTimeline(kind, id)
      .then((t) => {
        setData(t);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the timeline"));
  }

  useEffect(() => {
    setData(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id]);

  async function togglePause(paused: boolean) {
    setBusy(true);
    try {
      await setAutomationPaused(kind, id, paused);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  async function toggleOptOut(phone: string, optedOut: boolean) {
    const ok = optedOut
      ? window.confirm(`Mark ${phoneText(phone)} as opted out?\n\nNo automated or manual text will go to this number from any part of the app until you undo this. Emails are not affected. Only do this if the person asked not to be texted.`)
      : window.confirm(`Allow texts to ${phoneText(phone)} again?\n\nOnly do this if the person asked to be texted again. Twilio may still refuse a number that replied STOP until they reply START.`);
    if (!ok) return;
    setBusy(true);
    try {
      await setSmsOptOut(phone, optedOut);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="automation-timeline" aria-label="Automation timeline">
      <span className="detail-field-label">Automation timeline</span>
      {error && <p className="form-error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          <label className="automation-pause">
            <input type="checkbox" checked={data.paused} disabled={busy} onChange={(e) => togglePause(e.target.checked)} />
            <span>Pause automated messages</span>
          </label>
          {data.paused && <p className="muted settings-help">Paused by staff. Timed messages for this record will not go out. Messages sent when a stage changes are not affected.</p>}
          {data.entries.length === 0 && <p className="muted">{kind === "gig" ? "No crew member has accepted this gig yet, so no reminders are planned." : "Nothing is planned."}</p>}
          {data.entries.map((entry, n) => (
            <div key={n} className="automation-entry">
              {kind === "gig" && <strong>{entry.name}</strong>}
              <p className="automation-summary">{entry.summary}</p>
              {entry.items.length > 0 && (
                <ul className="addon-list">
                  {entry.items.map((i) => (
                    <li key={`${i.triggerKey}:${i.channel}:${i.dueAt}`}>
                      <span className={`msg-status ${STATE_CLASS[i.state]}`}>{STATE_LABEL[i.state]}</span> {i.what}, {i.when}
                      {i.reason && i.state !== "sent" && <span className="muted"> · {i.reason}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {entry.phone && (
                <p className="automation-optout">
                  {entry.optedOut ? (
                    <>
                      <span className="msg-status msg-failed">Opted out of texts</span> {phoneText(entry.phone)}{" "}
                      <button type="button" className="link-button" disabled={busy} onClick={() => toggleOptOut(entry.phone as string, false)}>
                        Allow texts again
                      </button>
                    </>
                  ) : (
                    <button type="button" className="link-button" disabled={busy} onClick={() => toggleOptOut(entry.phone as string, true)}>
                      Mark {phoneText(entry.phone)} as opted out of texts
                    </button>
                  )}
                </p>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
