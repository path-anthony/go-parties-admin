import { type FormEvent, Fragment, useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/api";
import { OCCASION_GROUPS } from "../lib/occasions";
import type { AccountSettings } from "../lib/types";
import type { FieldSpec } from "../settingsCopy";

// Block A12. One form for one section of Settings. It reads the account
// settings, shows the section's fields, and saves only those fields, so a
// section can never change a value it doesn't show. Each control carries
// data-setting with its field name; the settings test uses that to prove no
// field was lost or doubled when the pages were rearranged.

type Value = string | boolean | string[];

// A page shows several forms at once. They share one load of the settings
// instead of asking once each. Any save drops it, so the next page always
// reads fresh values.
let pending: Promise<AccountSettings> | null = null;
function loadSettings(): Promise<AccountSettings> {
  if (!pending) {
    const p = getSettings();
    pending = p;
    const forget = () => setTimeout(() => (pending === p ? (pending = null) : undefined), 1500);
    p.then(forget, () => (pending = null));
  }
  return pending;
}
type Values = Record<string, Value>;

const initial = (f: FieldSpec): Value => (f.kind === "checkbox" ? false : f.kind === "occasions" ? [] : "");

function read(fields: FieldSpec[], s: AccountSettings): Values {
  const out: Values = {};
  for (const f of fields) {
    const v = s[f.key] as unknown;
    out[f.key] = f.kind === "checkbox" ? v === true : f.kind === "occasions" ? [...((v as string[]) ?? [])] : v === null || v === undefined ? "" : String(v);
  }
  return out;
}

// What goes to the server for each field. Numbers are numbers, an empty
// optional box is "not set", everything else goes as it is.
function patchFor(fields: FieldSpec[], values: Values): Partial<AccountSettings> {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.kind === "number") patch[f.key] = Number(v);
    else if ((f.kind === "text" || f.kind === "email") && f.nullable) patch[f.key] = String(v).trim() === "" ? null : v;
    else patch[f.key] = v;
  }
  return patch as Partial<AccountSettings>;
}

const snapshot = (fields: FieldSpec[], v: Values) => JSON.stringify(fields.map((f) => (f.kind === "occasions" ? [...(v[f.key] as string[])].sort() : v[f.key])));

export function SettingsForm({ fields, note }: { fields: FieldSpec[]; note?: (v: Record<string, string>) => string | null }) {
  const [values, setValues] = useState<Values>(() => Object.fromEntries(fields.map((f) => [f.key, initial(f)])));
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (s: AccountSettings) => {
    const v = read(fields, s);
    setValues(v);
    setSaved(snapshot(fields, v));
  };

  useEffect(() => {
    // Only the latest load counts (a repeated mount must not put old values
    // back over something already typed).
    let current = true;
    loadSettings()
      .then((s) => current && apply(s))
      .catch((err) => current && setError(err instanceof Error ? err.message : "Couldn't load the settings"));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      pending = null;
      apply(await updateSettings(patchFor(fields, values)));
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const ready = saved !== null;
  const dirty = ready && saved !== snapshot(fields, values);
  const set = (key: string, v: Value) => setValues((prev) => ({ ...prev, [key]: v }));
  const text = (key: string) => String(values[key] ?? "");

  function toggleOccasion(key: string, value: string, on: boolean) {
    const prev = values[key] as string[];
    set(key, on ? [...new Set([...prev, value])] : prev.filter((o) => o !== value));
  }

  function control(f: FieldSpec) {
    if (f.kind === "checkbox") {
      return (
        <Fragment key={f.key}>
          <label className="checkbox-label">
            <input type="checkbox" data-setting={f.key} checked={values[f.key] === true} onChange={(e) => set(f.key, e.target.checked)} disabled={!ready || busy} />
            {f.label}
          </label>
          <span className="muted field-help">{f.help}</span>
        </Fragment>
      );
    }
    if (f.kind === "occasions") {
      const picked = values[f.key] as string[];
      return (
        <div className="detail-field" key={f.key}>
          <span className="detail-field-label">{f.label}</span>
          <div className="occasion-review-grid" role="group" aria-label={f.label} data-setting={f.key}>
            {OCCASION_GROUPS.map((group) => (
              <div key={group.label} className="occasion-group">
                <label className="checkbox-label">
                  <input type="checkbox" checked={picked.includes(group.label)} onChange={(e) => toggleOccasion(f.key, group.label, e.target.checked)} disabled={!ready || busy} />
                  <strong>{group.label}</strong> <span className="muted">(all of it)</span>
                </label>
                <div className="skill-grid">
                  {group.occasions.map((occ) => (
                    <label key={occ} className="checkbox-label">
                      <input type="checkbox" checked={picked.includes(occ) || picked.includes(group.label)} onChange={(e) => toggleOccasion(f.key, occ, e.target.checked)} disabled={!ready || busy || picked.includes(group.label)} />
                      {occ}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <span className="muted field-help">{f.help}</span>
        </div>
      );
    }
    return (
      <label key={f.key}>
        {f.label}
        {f.kind === "select" ? (
          <select data-setting={f.key} value={text(f.key)} onChange={(e) => set(f.key, e.target.value)} disabled={!ready || busy}>
            {(f.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            data-setting={f.key}
            type={f.kind === "number" ? "number" : f.kind === "email" ? "email" : "text"}
            min={f.min}
            max={f.max}
            step={f.step}
            maxLength={f.maxLength}
            placeholder={f.placeholder}
            value={text(f.key)}
            onChange={(e) => set(f.key, e.target.value)}
            disabled={!ready || busy}
            required={f.required === true}
          />
        )}
        <span className="muted field-help">{f.help}</span>
      </label>
    );
  }

  // Fields with the same row sit side by side, in the order written.
  const blocks: FieldSpec[][] = [];
  for (const f of fields) {
    const last = blocks[blocks.length - 1];
    if (f.row && last && last[0].row === f.row) last.push(f);
    else blocks.push([f]);
  }

  const noteText = note ? note(Object.fromEntries(fields.map((f) => [f.key, text(f.key)]))) : null;

  return (
    <form onSubmit={handleSave} className="add-item-form">
      {blocks.map((block) =>
        block[0].row ? (
          <div key={block[0].key}>
            {block[0].groupLabel && <span className="detail-field-label">{block[0].groupLabel}</span>}
            <div className="field-row">{block.map(control)}</div>
          </div>
        ) : (
          block.map(control)
        ),
      )}
      {noteText && <span className="muted field-help">{noteText}</span>}
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
