import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { getMessageTemplates, previewMessageTemplate, resetMessageTemplate, saveMessageTemplate, setMessageEnabled } from "../lib/api";
import { countSms } from "../lib/sms";
import type { MessageTrigger, TemplatePreview, TokenInfo } from "../lib/types";

const GROUPS = [
  { journey: "lead", title: "Leads", blurb: "People who asked about a party and haven't booked yet." },
  { journey: "client", title: "Clients", blurb: "People who have booked, from contract to thank you." },
  { journey: "crew", title: "Crew", blurb: "DJs, performers and staff who work your events." },
] as const;

const KIND = {
  transactional: "Sends right away, any time of day.",
  reminder: "Texts only between 9 AM and 8 PM Eastern. Can go on a Sunday.",
  nurture: "Texts only between 9 AM and 8 PM Eastern. Never on a Sunday.",
} as const;

// Settings > Messages. Every automated text and email, in three groups.
// Each row says in plain words when it sends and when it stops, and has a
// switch per channel. Click a row to change the wording.
export function MessageTemplatesPanel() {
  const [triggers, setTriggers] = useState<MessageTrigger[] | null>(null);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function load() {
    const r = await getMessageTemplates();
    setTriggers(r.triggers);
    setTokens(r.tokens);
  }

  useEffect(() => {
    getMessageTemplates()
      .then((r) => {
        setTriggers(r.triggers);
        setTokens(r.tokens);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the messages"));
  }, []);

  async function toggle(t: MessageTrigger, channel: "sms" | "email", enabled: boolean) {
    setBusyKey(`${t.key}:${channel}`);
    setError(null);
    try {
      await setMessageEnabled(t.key, channel, enabled);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusyKey(null);
    }
  }

  const open = triggers?.find((t) => t.key === openKey) ?? null;

  return (
    <div>
      <p className="muted settings-help">
        These are the texts and emails the system sends for you. Turn any of them off, or change what they say. "Customized" means you changed
        the wording. Reset puts it back. Texts of some kinds only go out between 9 AM and 8 PM Eastern, and follow-ups never go on Sundays.
      </p>
      {error && <p className="form-error">{error}</p>}
      {!triggers && !error && <p className="muted">Loading…</p>}
      {triggers &&
        GROUPS.map((g) => (
          <section key={g.journey} className="modal-section">
            <h3>{g.title}</h3>
            <p className="muted">{g.blurb}</p>
            <div className="table-scroll">
              <table className="items-table scheduling-table">
                <thead>
                  <tr>
                    <th>Message</th>
                    <th>When it sends</th>
                    <th>It stops when</th>
                    <th>Text</th>
                    <th>Email</th>
                  </tr>
                </thead>
                <tbody>
                  {triggers
                    .filter((t) => t.journey === g.journey)
                    .map((t) => (
                      <tr key={t.key} className="catalog-row" onClick={() => setOpenKey(t.key)} aria-label={`Edit ${t.label}`}>
                        <td>
                          <strong>{t.label}</strong>
                          {(t.sms.customized || t.email.customized) && <span className="customized-badge">Customized</span>}
                          {!t.wired && <div className="not-wired-note">Not sending yet. {t.unwiredReason}</div>}
                        </td>
                        <td className="muted">{t.when}</td>
                        <td className="muted">{t.stopsWhen}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <label className="checkbox-label">
                            <input type="checkbox" checked={t.sms.enabled} disabled={busyKey === `${t.key}:sms`} onChange={(e) => toggle(t, "sms", e.target.checked)} aria-label={`Text on for ${t.label}`} />
                            On
                          </label>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <label className="checkbox-label">
                            <input type="checkbox" checked={t.email.enabled} disabled={busyKey === `${t.key}:email`} onChange={(e) => toggle(t, "email", e.target.checked)} aria-label={`Email on for ${t.label}`} />
                            On
                          </label>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      {open && <TemplateModal trigger={open} tokens={tokens} onClose={() => setOpenKey(null)} onChanged={load} />}
    </div>
  );
}

function TemplateModal({ trigger, tokens, onClose, onChanged }: { trigger: MessageTrigger; tokens: TokenInfo[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const current = trigger[channel];
  const [subject, setSubject] = useState(current.subject);
  const [body, setBody] = useState(current.body);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const focused = useRef<"subject" | "body">("body");

  // Switching channel loads that channel's wording.
  function pick(next: "sms" | "email") {
    setChannel(next);
    setSubject(trigger[next].subject);
    setBody(trigger[next].body);
    setMessage(null);
    setError(null);
    setPreview(null);
  }

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && !(e.target instanceof HTMLElement && e.target.matches("input, textarea, select"))) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Live preview, a moment after typing stops.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      previewMessageTemplate(trigger.key, { channel, subject, body })
        .then((p) => live && setPreview(p))
        .catch(() => live && setPreview(null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [trigger.key, channel, subject, body]);

  const allowed = useMemo(() => tokens.filter((t) => trigger.tokens.includes(t.key)), [tokens, trigger.tokens]);
  const dirty = body !== current.body || (channel === "email" && subject !== current.subject);
  const sms = channel === "sms" ? countSms(preview?.body ?? body) : null;

  // Chips drop the token where the cursor is, in the field last used.
  function insert(key: string) {
    const token = `{{${key}}}`;
    const onSubject = channel === "email" && focused.current === "subject";
    const el = onSubject ? subjectRef.current : bodyRef.current;
    const value = onSubject ? subject : body;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    if (onSubject) setSubject(next);
    else setBody(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={trigger.label} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{trigger.label}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="muted">{trigger.when}</p>
        <p className="muted">It stops when: {trigger.stopsWhen}</p>
        <p className="muted">{KIND[trigger.sendClass]}</p>
        {!trigger.wired && <p className="not-wired-note">Not sending yet. {trigger.unwiredReason} You can still write it now.</p>}

        <div className="filter-row" role="group" aria-label="Which message to edit">
          {(["sms", "email"] as const).map((c) => (
            <button key={c} type="button" aria-pressed={channel === c} className={channel === c ? "btn-primary" : "btn-secondary"} onClick={() => pick(c)}>
              {c === "sms" ? "Text" : "Email"}
              {trigger[c].customized ? " (customized)" : ""}
            </button>
          ))}
        </div>

        {channel === "email" && (
          <label>
            Subject
            <input ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)} onFocus={() => (focused.current = "subject")} maxLength={200} />
          </label>
        )}
        <label>
          {channel === "sms" ? "Text message" : "Email message"}
          <textarea ref={bodyRef} rows={channel === "sms" ? 5 : 9} value={body} onChange={(e) => setBody(e.target.value)} onFocus={() => (focused.current = "body")} />
        </label>
        {sms && (
          <span className={`tpl-count ${sms.segments > 2 ? "tpl-count-warn" : "muted"}`}>
            {sms.characters} characters, {sms.segments} {sms.segments === 1 ? "text" : "texts"} ({sms.encoding}, {sms.perSegment} per text)
            {sms.encoding === "Unicode" ? ". A special character makes each text shorter." : ""}
          </span>
        )}

        <div>
          <span className="detail-field-label">Tap to add a detail</span>
          <div className="chip-row">
            {allowed.map((t) => (
              <button key={t.key} type="button" className={`token-chip${t.unavailable ? " token-chip-off" : ""}`} title={t.unavailable ? `${t.label}. Not available yet: ${t.unavailable}` : t.label} onClick={() => insert(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          {allowed.some((t) => t.unavailable) && <span className="muted field-help">Faded details can't be filled in yet. A message that uses one is held back and shows in the log as "Blocked".</span>}
        </div>

        <div>
          <span className="detail-field-label">What it looks like</span>
          {channel === "email" && preview?.subject && <div><strong>{preview.subject}</strong></div>}
          <pre className="tpl-preview">{preview ? preview.body : "…"}</pre>
          <span className="muted field-help">
            {preview?.record ? `Filled in from ${preview.record.label}.` : "No real record yet, so this uses sample details."}
            {preview && preview.fromSample.length > 0 ? ` Sample details used for: ${preview.fromSample.join(", ")}.` : ""}
            {preview && preview.notAllowed.length > 0 ? ` These can't be used here: ${preview.notAllowed.join(", ")}.` : ""}
          </span>
        </div>

        {message && (
          <p className="bulk-result" role="status">
            {message}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !dirty}
            onClick={() => run(async () => { await saveMessageTemplate(trigger.key, channel, { subject: channel === "email" ? subject : undefined, body, enabled: current.enabled }); return "Saved."; })}
          >
            Save
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || (!current.customized && body === current.defaultBody && subject === current.defaultSubject)}
            onClick={() =>
              run(async () => {
                const r = await resetMessageTemplate(trigger.key, channel);
                setBody(r.body);
                setSubject(r.subject);
                return "Back to the original wording.";
              })
            }
          >
            Reset to default
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
