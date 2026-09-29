import { useState } from "react";
import { sendMessage } from "../lib/api";
import { describeSend } from "../lib/messages";
import type { MessageLogRow, MessageTarget } from "../lib/types";

// The two hand-operated buttons, always available whatever the automation
// is doing: send the customer their contract link, or send a reminder
// staff type. For a crew member only the reminder applies (there is no
// crew contract). Every press is logged.
export function SendMessageControls({ target, contract = true, label }: { target: MessageTarget; contract?: boolean; label?: string }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MessageLogRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "contract-link" | "custom") {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const row = await sendMessage(target, kind, kind === "custom" ? text : undefined);
      setResult(row);
      if (kind === "custom" && row.status !== "failed") {
        setText("");
        setTyping(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="send-controls">
      {label && <span className="detail-field-label">{label}</span>}
      <div className="form-actions">
        {contract && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => run("contract-link")}>
            Send contract link
          </button>
        )}
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => setTyping((t) => !t)} aria-expanded={typing}>
          Send reminder
        </button>
      </div>
      {typing && (
        <div className="send-typing">
          <textarea
            rows={3}
            value={text}
            maxLength={1000}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type the text message to send"
            aria-label="Message to send"
            disabled={busy}
          />
          <button type="button" className="btn-primary" disabled={busy || text.trim() === ""} onClick={() => run("custom")}>
            {busy ? "Sending…" : "Send text"}
          </button>
        </div>
      )}
      {result && (
        <p className={result.status === "failed" ? "form-error" : "muted"} role="status">
          {describeSend(result)}
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
