import { useEffect, useState } from "react";
import { getMessageTemplates, getMessages } from "../lib/api";
import { statusClass, statusLabel } from "../lib/messages";
import type { MessageLogRow } from "../lib/types";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const JOURNEY = { lead: "Leads", client: "Clients", crew: "Crew" } as const;

// The one place to see whether a text or email actually went out: the last
// 200 sends across all three journeys. Click a row for the exact message
// and any error. "Sent" means handed to Twilio or the email webhook;
// "Delivered" only appears when n8n reports it.
export function MessageLogPanel() {
  const [rows, setRows] = useState<MessageLogRow[] | null>(null);
  const [journey, setJourney] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    getMessageTemplates()
      .then((r) => setLabels(Object.fromEntries(r.triggers.map((t) => [t.key, t.label]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let live = true;
    getMessages({ journey: journey || undefined, status: status || undefined, limit: 200 })
      .then((r) => live && setRows(r))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load the log"));
    return () => {
      live = false;
    };
  }, [journey, status]);

  const loading = rows === null;
  return (
    <div>
      <div className="filter-row">
        <select
          value={journey}
          onChange={(e) => {
            setRows(null);
            setJourney(e.target.value);
          }}
          aria-label="Journey"
        >
          <option value="">All journeys</option>
          <option value="lead">Leads</option>
          <option value="client">Clients</option>
          <option value="crew">Crew</option>
        </select>
        <select
          value={status}
          onChange={(e) => {
            setRows(null);
            setStatus(e.target.value);
          }}
          aria-label="Status"
        >
          <option value="">Any status</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="skipped_disabled">Switched off</option>
          <option value="blocked_missing_field">Blocked: missing info</option>
          <option value="deferred*">Held (quiet hours or Sunday)</option>
          <option value="skipped-*">Not sent (setup missing)</option>
        </select>
      </div>
      {error && <p className="form-error">{error}</p>}
      {loading && !error && <p className="muted">Loading…</p>}
      {!loading && rows.length === 0 && <p className="muted">Nothing here yet.</p>}
      {!loading && rows.length > 0 && (
        <div className="table-scroll">
          <table className="items-table scheduling-table">
            <thead>
              <tr>
                <th>When (ET)</th>
                <th>Journey</th>
                <th>Message</th>
                <th>To</th>
                <th>Result</th>
                <th>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="catalog-row" onClick={() => setOpen(open === r.id ? null : r.id)} aria-label={`Message to ${r.recipient}`}>
                  <td>{when(r.createdAt)}</td>
                  <td>{r.journey ? JOURNEY[r.journey] : <span className="muted">Other</span>}</td>
                  <td>
                    {r.triggerKey === "manual_message" ? "Typed by staff" : r.triggerKey ? (labels[r.triggerKey] ?? r.triggerKey) : r.purpose}
                    <span className="muted"> · {r.channel === "sms" ? "Text" : "Email"}</span>
                    {r.source === "n8n" && <span className="muted"> (n8n)</span>}
                    {open === r.id && (
                      <div>
                        {r.subject && <div><strong>{r.subject}</strong></div>}
                        <pre className="msg-body">{r.body}</pre>
                        {r.error && <div className="form-error">{r.error}</div>}
                        {r.idempotencyKey && <div className="muted">Key: {r.idempotencyKey}</div>}
                      </div>
                    )}
                  </td>
                  <td>{r.recipient}</td>
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
    </div>
  );
}
