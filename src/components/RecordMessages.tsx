import { useEffect, useState } from "react";
import { getMessages } from "../lib/api";
import { statusClass, statusLabel } from "../lib/messages";
import type { MessageLogRow } from "../lib/types";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

// The last 10 messages about one booking, lead or gig, on its detail
// screen. Click one to read it.
export function RecordMessages({ bookingId, leadId, gigId }: { bookingId?: string; leadId?: string; gigId?: string }) {
  const [rows, setRows] = useState<MessageLogRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getMessages({ bookingId, leadId, gigId, limit: 10 })
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [bookingId, leadId, gigId]);

  return (
    <div className="record-messages" aria-label="Messages">
      <span className="detail-field-label">Messages</span>
      {rows === null && <p className="muted">Loading…</p>}
      {rows?.length === 0 && <p className="muted">Nothing has been sent about this yet.</p>}
      {rows && rows.length > 0 && (
        <ul className="addon-list">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="link-button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                {when(r.createdAt)} · {r.channel === "sms" ? "Text" : "Email"} to {r.recipient}
              </button>{" "}
              <span className={`msg-status ${statusClass(r.status)}`}>{statusLabel(r.status)}</span>
              {r.confirmation === "delivered" && <span className="msg-status msg-sent"> Delivered</span>}
              {open === r.id && (
                <div>
                  {r.subject && <strong>{r.subject}</strong>}
                  <pre className="msg-body">{r.body}</pre>
                  {r.error && <div className="form-error">{r.error}</div>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
