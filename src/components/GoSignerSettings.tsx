import { type FormEvent, useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/api";

// Who signs for GO. When both are filled in, every signed contract gets a
// second signature block for them, applied automatically after the
// customer signs. Leave either empty and that block is left off.
export function GoSignerSettings() {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const snap = (n: string, t: string) => JSON.stringify([n, t]);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setName(s.authorizedSignerName ?? "");
        setTitle(s.authorizedSignerTitle ?? "");
        setSaved(snap(s.authorizedSignerName ?? "", s.authorizedSignerTitle ?? ""));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the settings"));
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const s = await updateSettings({
        authorizedSignerName: name.trim() === "" ? null : name,
        authorizedSignerTitle: title.trim() === "" ? null : title,
      });
      setName(s.authorizedSignerName ?? "");
      setTitle(s.authorizedSignerTitle ?? "");
      setSaved(snap(s.authorizedSignerName ?? "", s.authorizedSignerTitle ?? ""));
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const ready = saved !== null;
  const dirty = ready && saved !== snap(name, title);
  const half = ready && (name.trim() === "") !== (title.trim() === "");
  return (
    <form onSubmit={handleSave} className="add-item-form">
      <div className="field-row">
        <label>
          Authorized signer name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Andy Caron" disabled={!ready || busy} maxLength={120} />
        </label>
        <label>
          Authorized signer title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Owner" disabled={!ready || busy} maxLength={120} />
        </label>
      </div>
      <span className="muted field-help">
        {half
          ? "Both are needed. With one empty, contracts are signed by the customer only."
          : "Signed contracts get a second block for this person, dated the day the customer signs. Empty means no GO signature."}
      </span>
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {message && <span className="muted">{message}</span>}
        {error && <span className="form-error">{error}</span>}
      </div>
    </form>
  );
}
