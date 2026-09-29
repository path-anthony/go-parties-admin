import { useEffect, useState } from "react";
import { getMessages } from "../../lib/api";
import type { MessageLogRow } from "../../lib/types";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const statusClass = (s: string) => (s === "sent" ? "msg-sent" : s === "failed" ? "msg-failed" : s === "queued" ? "msg-queued" : "msg-skipped");
const statusLabel = (s: string) =>
  ({
    sent: "Sent",
    failed: "Failed",
    queued: "Queued",
    "skipped-no-token": "Skipped: no Twilio token",
    "skipped-not-configured": "Skipped: Twilio not set up",
    "skipped-no-webhook": "Skipped: no email webhook",
    "skipped-no-policy": "Skipped: no policy text",
  })[s] ?? s;

// The one place to see whether a text or email actually went out: our own
// attempts (sent, failed, or skipped because a setting wasn't there) and,
// when n8n reports back, whether it was delivered.
export function MessagesScreen() {
  const [rows, setRows] = useState<MessageLogRow[] | null>(null);
  const [channel, setChannel] = useState<"" | "sms" | "email">("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getMessages({ channel: channel || undefined, status: status || undefined })
      .then((r) => live && setRows(r))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load the log"));
    return () => {
      live = false;
    };
  }, [channel, status]);

  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Messages</h2>
        <p className="muted">
          Every text and email the system tried to send. "Sent" means handed to Twilio or to the email webhook; "Delivered" appears only
          when n8n reports it. "Skipped" means a setting was missing, so nothing was attempted.
        </p>
      </div>
      <section className="panel">
        <div className="filter-row">
          <select value={channel} onChange={(e) => { setRows(null); setChannel(e.target.value as "" | "sms" | "email"); }} aria-label="Channel">
            <option value="">Texts and emails</option>
            <option value="sms">Texts</option>
            <option value="email">Emails</option>
          </select>
          <select value={status} onChange={(e) => { setRows(null); setStatus(e.target.value); }} aria-label="Status">
            <option value="">Any status</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="skipped*">Skipped</option>
          </select>
        </div>
        {error && <p className="form-error">{error}</p>}
        {!rows && !error && <p className="muted">Loading…</p>}
        {rows && rows.length === 0 && <p className="muted">Nothing has been sent yet.</p>}
        {rows && rows.length > 0 && (
          <div className="table-scroll">
            <table className="items-table scheduling-table">
              <thead>
                <tr>
                  <th>When (ET)</th>
                  <th>Channel</th>
                  <th>To</th>
                  <th>Why</th>
                  <th>Attempt</th>
                  <th>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="catalog-row" onClick={() => setOpen(open === r.id ? null : r.id)} aria-label={`Message to ${r.recipient}`}>
                    <td>{when(r.createdAt)}</td>
                    <td>{r.channel === "sms" ? "Text" : "Email"}{r.source === "n8n" ? " (n8n)" : ""}</td>
                    <td>
                      {r.recipient}
                      {open === r.id && (
                        <>
                          {r.subject && <div><strong>{r.subject}</strong></div>}
                          <pre className="msg-body">{r.body}</pre>
                          {r.error && <div className="form-error">{r.error}</div>}
                        </>
                      )}
                    </td>
                    <td className="muted">{r.purpose}</td>
                    <td>
                      <span className={`msg-status ${statusClass(r.status)}`}>{statusLabel(r.status)}</span>
                    </td>
                    <td>
                      {r.confirmation ? (
                        <span className={`msg-status ${r.confirmation === "delivered" ? "msg-sent" : "msg-failed"}`} title={r.confirmationDetail ?? ""}>
                          {r.confirmation === "delivered" ? "Delivered" : "Failed"}
                        </span>
                      ) : (
                        <span className="muted">Not reported</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
