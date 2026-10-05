import { useEffect, useState } from "react";
import { getPolicy, savePolicy } from "../lib/api";
import type { PolicyVersionInfo } from "../lib/types";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

// The cancellation and retainer policy customers agree to. Saving never
// overwrites: it adds the next version, and every earlier one stays below
// with how many agreements point at it, so what a customer saw can always
// be looked up.
export function PolicyEditor() {
  const [versions, setVersions] = useState<PolicyVersionInfo[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function load() {
    const p = await getPolicy();
    setVersions(p.versions);
    setDraft(p.current.text);
  }

  useEffect(() => {
    getPolicy()
      .then((p) => {
        setVersions(p.versions);
        setDraft(p.current.text);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the policy"));
  }, []);

  const current = versions?.[0];
  const dirty = current !== undefined && draft !== current.text;

  async function handleSave() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await savePolicy(draft);
      await load();
      setMessage(result.created ? `Saved as version ${result.version.version}. The earlier versions are kept.` : "No change to save.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label>
        {current ? `Current text (version ${current.version})` : "Current text"}
        <textarea
          className="policy-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!versions || busy}
          placeholder="Write the cancellation and retainer policy customers will see and agree to."
          aria-label="Cancellation and retainer policy text"
        />
      </label>
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
                {when(v.createdAt)} · {v.agreements} {v.agreements === 1 ? "agreement" : "agreements"}
                {v.id === versions[0].id ? " · current" : ""}
              </span>
              {open === v.id && <pre>{v.text === "" ? "(empty)" : v.text}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
