import { useEffect, useState } from "react";
import { activatePolicyDraft, discardPolicyDraft, getPolicy, savePolicy, savePolicyDraft } from "../lib/api";
import type { PolicyScreen, PolicyVersionInfo } from "../lib/types";
import { EDITOR_COPY } from "../settingsCopy";

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
  // Block FIX1: the draft of the next version and the suggested update.
  const [screen, setScreen] = useState<PolicyScreen | null>(null);
  const [nextText, setNextText] = useState("");

  async function load() {
    const p = await getPolicy();
    setVersions(p.versions);
    setDraft(p.current.text);
    setScreen(p);
    setNextText(p.draft?.text ?? "");
  }

  useEffect(() => {
    getPolicy()
      .then((p) => {
        setVersions(p.versions);
        setDraft(p.current.text);
        setScreen(p);
        setNextText(p.draft?.text ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the policy"));
  }, []);

  async function step(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      await load();
      setMessage(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save");
    } finally {
      setBusy(false);
    }
  }

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
        <span className="muted field-help">{EDITOR_COPY.policy.help}</span>
      </label>
      <div className="form-actions">
        <button type="button" className="btn-primary" onClick={handleSave} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save as a new version"}
        </button>
        {message && <span className="muted">{message}</span>}
        {error && <span className="form-error">{error}</span>}
      </div>

      {screen && (
        <div className="policy-draft" data-testid="policy-draft">
          <span className="detail-field-label">What customers read today</span>
          <span className="muted field-help">The live version with its numbers filled in from Settings. {"{{retainerPercent}}"} is the retainer percent in Booking rules, {"{{balanceDueDays}}"} the balance due days, {"{{cancellationWindowDays}}"} the cancellation window. Change a setting and this text changes with it. A customer who already accepted keeps the wording they accepted.</span>
          <pre className="policy-text-shown">{screen.asCustomersSeeIt || "(empty)"}</pre>
          {screen.hardcoded.length > 0 && (
            <p className="stage-warning" role="note">
              The live version has these typed in rather than taken from Settings: {screen.hardcoded.join(", ")}. They will not change when Settings change.
            </p>
          )}

          <span className="detail-field-label">Draft of the next version</span>
          <span className="muted field-help">A draft is not shown to anyone. Read it, change it if you want, then press "Make this the live version". The live version above stays in use until then.</span>
          {!screen.draft && screen.suggested && (
            <div className="add-item-form">
              <p className="muted">Suggested update: the same wording, with the retainer percent and matching day counts taken from Settings, and "deposit" changed to "retainer".</p>
              <pre className="policy-text-shown">{screen.suggested}</pre>
              <div className="form-actions">
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void step(() => savePolicyDraft(screen.suggested as string), "Saved as a draft. Nothing changed for customers.")}>
                  Save the suggestion as a draft
                </button>
              </div>
            </div>
          )}
          {screen.draft && (
            <div className="add-item-form">
              <p className="muted">
                Draft saved{screen.draft.savedBy ? ` by ${screen.draft.savedBy}` : ""}
                {screen.draft.savedAt ? ` on ${when(screen.draft.savedAt)}` : ""}. Not live.
              </p>
              <label>
                Draft text
                <textarea className="policy-textarea" value={nextText} onChange={(e) => setNextText(e.target.value)} disabled={busy} aria-label="Draft of the next policy version" />
              </label>
              <span className="detail-field-label">How customers would read it</span>
              <pre className="policy-text-shown">{screen.draft.asCustomersSeeIt}</pre>
              {screen.draft.hardcoded.length > 0 && <p className="stage-warning">Still typed in: {screen.draft.hardcoded.join(", ")}.</p>}
              <div className="form-actions">
                {nextText !== screen.draft.text && (
                  <button type="button" className="btn-secondary" disabled={busy || nextText.trim() === ""} onClick={() => void step(() => savePolicyDraft(nextText), "Draft saved.")}>
                    Save draft
                  </button>
                )}
                <button type="button" className="btn-primary" disabled={busy || nextText !== screen.draft.text} onClick={() => void step(() => activatePolicyDraft(), "The draft is now the live version. Earlier versions are kept, and customers who already accepted keep their wording.")}>
                  Make this the live version
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void step(() => discardPolicyDraft(), "Draft discarded.")}>
                  Discard draft
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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
