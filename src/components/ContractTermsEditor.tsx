import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { getContractTerms, getSettings, saveContractTerms } from "../lib/api";
import type { AccountSettings, GoTermsContent, TermsVersionInfo } from "../lib/types";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

// The business numbers the wording binds to, in the same spelling the server
// fills them (server/contract/goTemplate.ts).
const TOKEN_HELP = "{{retainerPercent}} {{lateCancellationDays}} {{balanceDueDays}} {{rescheduleFeePercent}} {{outsidePlannerChargePercent}} {{returnedCheckFee}}";

function fill(text: string, s: AccountSettings | null): string {
  if (!s) return text;
  const dollars = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const values: Record<string, string> = {
    retainerPercent: String(s.depositPercentage),
    lateCancellationDays: String(s.cancellationWindowDays),
    balanceDueDays: String(s.balanceDueDays),
    rescheduleFeePercent: String(s.rescheduleFeePercent),
    outsidePlannerChargePercent: String(s.outsidePlannerChargePercent),
    returnedCheckFee: dollars(s.returnedCheckFee),
  };
  return text.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (whole, key: string) => values[key] ?? whole);
}

// The GO contract's wording: header lines, the numbered clauses, the two
// notes, the acceptance block. Saving adds a version and never edits an
// earlier one; an agreement keeps the version its link was made with. The
// preview on the right shows the text with today's numbers filled in.
export function ContractTermsEditor() {
  const [versions, setVersions] = useState<TermsVersionInfo[] | null>(null);
  const [draft, setDraft] = useState<GoTermsContent | null>(null);
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  function load() {
    return getContractTerms().then((t) => {
      setVersions(t.versions);
      setDraft(structuredClone(t.current.content));
    });
  }
  useEffect(() => {
    Promise.all([load(), getSettings().then((s) => setSettings(s))]).catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the contract terms"));
  }, []);

  const current = versions?.[0];
  const dirty = !!current && !!draft && JSON.stringify(draft) !== JSON.stringify(current.content);

  function set<K extends keyof GoTermsContent>(key: K, value: GoTermsContent[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }
  function setClause(i: number, patch: Partial<{ title: string; body: string }>) {
    setDraft((d) => (d ? { ...d, terms: { ...d.terms, clauses: d.terms.clauses.map((c, k) => (k === i ? { ...c, ...patch } : c)) } } : d));
  }
  function moveClause(i: number, dir: -1 | 1) {
    setDraft((d) => {
      if (!d) return d;
      const list = [...d.terms.clauses];
      const j = i + dir;
      if (j < 0 || j >= list.length) return d;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...d, terms: { ...d.terms, clauses: list } };
    });
  }
  function removeClause(i: number) {
    setDraft((d) => (d ? { ...d, terms: { ...d.terms, clauses: d.terms.clauses.filter((_, k) => k !== i) } } : d));
  }
  function addClause() {
    setDraft((d) => (d ? { ...d, terms: { ...d.terms, clauses: [...d.terms.clauses, { title: "", body: "" }] } } : d));
  }

  async function handleSave() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await saveContractTerms(draft);
      await load();
      setMessage(result.created ? `Saved as version ${result.version.version}. Contracts sent from now on use it; earlier ones keep theirs.` : "No change to save.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  if (!draft) return error ? <p className="form-error">{error}</p> : <p className="muted">Loading…</p>;
  const d = draft;
  const text = (label: string, value: string, onChange: (v: string) => void, rows = 2) => (
    <label>
      {label}
      <textarea rows={rows} value={value} disabled={busy} onChange={(e) => onChange(e.target.value)} />
    </label>
  );

  return (
    <div className="terms-editor">
      <div className="terms-form">
        <p className="muted settings-help">
          The numbers come from Settings, written as merge fields: <code>{TOKEN_HELP}</code>. Change a number there and every contract sent from then on says the new one.
          {current ? ` Editing version ${current.version}.` : ""}
        </p>
        <h3>Header</h3>
        {text("Title", d.header.title, (v) => set("header", { ...d.header, title: v }), 1)}
        {text("Confirm-by line", d.header.confirmByLine, (v) => set("header", { ...d.header, confirmByLine: v }))}
        {text("Non-refundable line", d.header.nonRefundableLine, (v) => set("header", { ...d.header, nonRefundableLine: v }), 1)}
        <h3>Pages 2 and 3</h3>
        {text("Page header", d.terms.pageHeader, (v) => set("terms", { ...d.terms, pageHeader: v }), 1)}
        {text("Page subheader", d.terms.pageSubheader, (v) => set("terms", { ...d.terms, pageSubheader: v }))}
        {text("Terms heading", d.terms.heading, (v) => set("terms", { ...d.terms, heading: v }), 1)}
        <h3>Clauses</h3>
        <ol className="clause-list">
          {d.terms.clauses.map((c, i) => (
            <li key={i} className="clause-row">
              <div className="clause-head">
                <strong>{i + 1}.</strong>
                <input value={c.title} placeholder="Title" disabled={busy} onChange={(e) => setClause(i, { title: e.target.value })} aria-label={`Clause ${i + 1} title`} />
                <span className="form-actions">
                  <button type="button" className="icon-btn" disabled={busy || i === 0} onClick={() => moveClause(i, -1)} aria-label={`Move clause ${i + 1} up`}>
                    <ArrowUp size={14} />
                  </button>
                  <button type="button" className="icon-btn" disabled={busy || i === d.terms.clauses.length - 1} onClick={() => moveClause(i, 1)} aria-label={`Move clause ${i + 1} down`}>
                    <ArrowDown size={14} />
                  </button>
                  <button type="button" className="icon-btn" disabled={busy || d.terms.clauses.length === 1} onClick={() => removeClause(i)} aria-label={`Remove clause ${i + 1}`}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
              <textarea rows={3} value={c.body} disabled={busy} onChange={(e) => setClause(i, { body: e.target.value })} aria-label={`Clause ${i + 1} body`} />
            </li>
          ))}
        </ol>
        <button type="button" className="btn-secondary" disabled={busy || d.terms.clauses.length >= 40} onClick={addClause}>
          Add a clause
        </button>
        <h3>Notes and acceptance</h3>
        {text("Services note", d.servicesNote, (v) => set("servicesNote", v), 3)}
        {text("Payment note", d.paymentNote, (v) => set("paymentNote", v), 3)}
        {text("Acceptance heading", d.acceptance.heading, (v) => set("acceptance", { ...d.acceptance, heading: v }), 1)}
        {text("Acceptance text", d.acceptance.text, (v) => set("acceptance", { ...d.acceptance, text: v }), 3)}
        {text("E-sign label", d.acceptance.esignLabel, (v) => set("acceptance", { ...d.acceptance, esignLabel: v }))}
        {text("Closing line", d.acceptance.confirmLine, (v) => set("acceptance", { ...d.acceptance, confirmLine: v }))}
        {text("Footer line under it", d.acceptance.nonRefundableLine, (v) => set("acceptance", { ...d.acceptance, nonRefundableLine: v }), 1)}
        <div className="form-actions">
          <button type="button" className="btn-primary" onClick={handleSave} disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save as a new version"}
          </button>
          {message && <span className="muted">{message}</span>}
          {error && <span className="form-error">{error}</span>}
        </div>
        {versions && versions.length > 0 && (
          <div className="policy-history">
            <span className="detail-field-label">Version history</span>
            {versions.map((v) => (
              <div key={v.id} className="policy-version">
                <button type="button" className="btn-secondary" onClick={() => setOpen(open === v.id ? null : v.id)} aria-expanded={open === v.id}>
                  Version {v.version}
                </button>{" "}
                <span className="muted">
                  {when(v.createdAt)} · {v.agreements} {v.agreements === 1 ? "contract" : "contracts"}
                  {v.id === versions[0].id ? " · current" : ""}
                </span>
                {open === v.id && <pre>{v.content.terms.clauses.map((c, i) => `${i + 1}. ${c.title}. ${c.body}`).join("\n\n")}</pre>}
              </div>
            ))}
          </div>
        )}
      </div>

      <aside className="terms-preview" aria-label="Preview with today's numbers">
        <div className="go-bar">
          <strong>{d.header.title}</strong>
          <div>{d.header.confirmByLine}</div>
          <div>{d.header.nonRefundableLine}</div>
        </div>
        <p className="muted go-note">{fill(d.servicesNote, settings)}</p>
        <p className="go-note">{fill(d.paymentNote, settings)}</p>
        <div className="go-bar">
          <strong>{d.terms.pageHeader}</strong>
          <div>{d.terms.pageSubheader}</div>
        </div>
        <div className="go-bar go-bar-section">{d.terms.heading}</div>
        <ol className="go-clauses">
          {d.terms.clauses.map((c, i) => (
            <li key={i}>
              <b>
                {c.title}
                {c.title ? "." : ""}
              </b>{" "}
              {fill(c.body, settings)}
            </li>
          ))}
        </ol>
        <div className="go-bar go-bar-section">{d.acceptance.heading}</div>
        <p className="go-note">{fill(d.acceptance.text, settings)}</p>
        <p className="go-note">☐ {d.acceptance.esignLabel}</p>
        <p className="go-center">
          <b>{d.acceptance.confirmLine}</b>
          <br />
          {d.acceptance.nonRefundableLine}
        </p>
        {!settings && <p className="muted">Numbers load from Settings.</p>}
      </aside>
    </div>
  );
}
