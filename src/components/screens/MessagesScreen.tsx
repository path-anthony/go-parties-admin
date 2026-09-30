import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getUpcoming, runAutomationCheck } from "../../lib/api";
import type { RunResult, UpcomingView } from "../../lib/types";
import { MessageLogPanel } from "../MessageLogPanel";
import { MessageTemplatesPanel } from "../MessageTemplatesPanel";

// Messages is a group in the sidebar with three pages.

// What each automated text and email says, and whether it is on.
export function MessageTemplatesPage() {
  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Templates</h2>
        <p className="muted">The wording and on-off switches for every automated text and email.</p>
      </div>
      <section className="panel">
        <MessageTemplatesPanel />
      </section>
    </div>
  );
}

// Every text and email the system tried to send, newest first. This is the
// one send log; it used to be shown twice (its own screen and a Settings tab).
export function SentLogPage() {
  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Sent log</h2>
        <p className="muted">
          The last 200 texts and emails, newest first. "Sent" means handed to Twilio or the email webhook. "Not sent" means a setting
          was missing, so nothing was attempted. Click one to read it and see any error. Edit the wording under Templates.
        </p>
      </div>
      <section className="panel">
        <MessageLogPanel />
      </section>
    </div>
  );
}

const dayHeading = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const COUNT_LABEL: [keyof RunResult["counts"]["total"], string][] = [
  ["sent", "sent"],
  ["failed", "failed"],
  ["blocked", "blocked"],
  ["skipped", "skipped"],
];

function RunSummary({ result }: { result: RunResult }) {
  const t = result.counts.total;
  return (
    <div className="panel">
      <h3>{result.dryRun ? "Preview: what would go out right now" : "Check finished"}</h3>
      <p>
        {result.dryRun
          ? t.due + result.lines.filter((l) => l.result !== "would send").length === 0
            ? "Nothing is due right now."
            : `${t.due} message${t.due === 1 ? "" : "s"} due now.`
          : `${t.sent} sent, ${t.failed} failed, ${t.blocked} blocked, ${t.skipped} skipped.`}
      </p>
      {result.lines.length > 0 && (
        <ul className="addon-list">
          {result.lines.map((l, i) => (
            <li key={i}>
              <Link to={l.href}>{l.name}</Link>: {l.what} <span className="muted">· {l.result}{l.reason ? ` (${l.reason})` : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {!result.dryRun && COUNT_LABEL.length > 0 && <p className="muted">Lead {result.counts.lead.sent} sent · Client {result.counts.client.sent} sent · Crew {result.counts.crew.sent} sent</p>}
    </div>
  );
}

// The next 14 days of planned sends from the scheduler's own planner, grouped
// by day, each linking to its record. Blocked ones are flagged now, not when
// they were due. "Run check now" previews first, then asks before sending.
export function MessagesUpcomingPage() {
  const [data, setData] = useState<UpcomingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RunResult | null>(null);
  const [finished, setFinished] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    return getUpcoming()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load"));
  }
  useEffect(() => {
    void load();
  }, []);

  async function startCheck() {
    setBusy(true);
    setFinished(null);
    try {
      setPreview(await runAutomationCheck(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't run the preview");
    } finally {
      setBusy(false);
    }
  }
  async function confirmCheck() {
    setBusy(true);
    try {
      setFinished(await runAutomationCheck(false));
      setPreview(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't run the check");
    } finally {
      setBusy(false);
    }
  }

  const days: { key: string; heading: string; rows: UpcomingView["entries"] }[] = [];
  for (const e of data?.entries ?? []) {
    const k = dayKey(e.sendAt);
    const last = days[days.length - 1];
    if (last?.key === k) last.rows.push(e);
    else days.push({ key: k, heading: dayHeading(e.sendAt), rows: [e] });
  }
  const blocked = (data?.entries ?? []).filter((e) => e.state === "blocked");

  return (
    <div className="screen screen-wide">
      <div className="screen-head screen-head-row">
        <div>
          <h2>Upcoming</h2>
          <p className="muted">
            The automated texts and emails planned for the next 14 days. The scheduler checks every hour; this is the same plan it follows. Pause a record from its own
            timeline.
          </p>
        </div>
        <button type="button" className="btn" disabled={busy} onClick={startCheck}>
          Run check now
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}

      {preview && (
        <>
          <RunSummary result={preview} />
          <p>
            <button type="button" className="btn btn-primary" disabled={busy || preview.lines.length === 0} onClick={confirmCheck}>
              Send these now
            </button>{" "}
            <button type="button" className="btn" disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </button>
          </p>
        </>
      )}
      {finished && <RunSummary result={finished} />}

      {data && data.needsAttention > 0 && (
        <section className="panel upcoming-attention" role="alert">
          <h3>Needs attention: {data.needsAttention}</h3>
          <p className="muted">These texts or emails failed 3 times and were given up on. Look at the record and send by hand if it still matters.</p>
          <ul className="addon-list">
            {data.failed.map((f) => (
              <li key={f.id}>
                {f.href ? <Link to={f.href}>{f.recipient}</Link> : f.recipient} · {f.channel === "sms" ? "text" : "email"} · {f.triggerKey ?? "message"}
                <span className="muted"> · {f.error ?? "failed"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data && data.needsAttention === 0 && <p className="muted">Needs attention: 0</p>}

      {blocked.length > 0 && (
        <section className="panel">
          <h3>Blocked in advance: {blocked.length}</h3>
          <p className="muted">These cannot go until something is fixed. They are also listed on their day below.</p>
        </section>
      )}

      {!data && !error && <p className="muted">Loading…</p>}
      {data && days.length === 0 && <p className="muted">Nothing is planned for the next 14 days.</p>}
      {days.map((d) => (
        <section key={d.key}>
          <h3 className="upcoming-day">{d.heading}</h3>
          {d.rows.map((r, i) => (
            <div key={i} className="upcoming-row">
              <span className={`msg-status ${r.state === "blocked" ? "msg-failed" : "msg-queued"}`}>{r.state === "blocked" ? "Blocked" : r.state === "due" ? "Due now" : "Scheduled"}</span>
              <Link to={r.href}>{r.name}</Link>
              <span>
                {r.what}, {r.when.replace(/^.* at /, "")}
              </span>
              {r.reason && <span className="muted">· {r.reason}</span>}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
