import { type FormEvent, useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/api";
import type { AccountSettings } from "../lib/types";
import { PhotoDropZone } from "./PhotoDropZone";

// The company details as they print on the GO contract, the business numbers
// its wording binds to, the sign-and-pay window, the replaceable logo, and
// the rollout switch. The retainer share and the cancellation window live
// under Business rules and are reused here, not duplicated.
export function ContractSettingsForm() {
  const [s, setS] = useState<AccountSettings | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [useGo, setUseGo] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logoBump, setLogoBump] = useState(0);

  const FIELDS = ["contractCompanyName", "contractAddressLine", "contractPhone", "contractEmail", "contractWebsite", "contractFooterLine", "balanceDueDays", "rescheduleFeePercent", "outsidePlannerChargePercent", "returnedCheckFee", "signAndPayWindowDays"] as const;
  const snap = (f: Record<string, string>, go: boolean) => JSON.stringify([FIELDS.map((k) => f[k] ?? ""), go]);
  const apply = (next: AccountSettings) => {
    setS(next);
    const f: Record<string, string> = {};
    for (const k of FIELDS) f[k] = String(next[k]);
    setForm(f);
    setUseGo(next.useGoContract);
    setSaved(snap(f, next.useGoContract));
  };

  useEffect(() => {
    getSettings()
      .then(apply)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the settings"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      apply(
        await updateSettings({
          contractCompanyName: form.contractCompanyName,
          contractAddressLine: form.contractAddressLine,
          contractPhone: form.contractPhone,
          contractEmail: form.contractEmail,
          contractWebsite: form.contractWebsite,
          contractFooterLine: form.contractFooterLine,
          balanceDueDays: Number(form.balanceDueDays),
          rescheduleFeePercent: Number(form.rescheduleFeePercent),
          outsidePlannerChargePercent: Number(form.outsidePlannerChargePercent),
          returnedCheckFee: Number(form.returnedCheckFee),
          signAndPayWindowDays: Number(form.signAndPayWindowDays),
          useGoContract: useGo,
        }),
      );
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  async function setLogo(dataUrl: string | null) {
    setBusy(true);
    setError(null);
    try {
      apply(await updateSettings({ contractLogo: dataUrl }));
      setLogoBump((n) => n + 1);
      setMessage(dataUrl ? "Logo saved. New contracts and PDFs use it." : "Logo removed. The built-in placeholder is used.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the logo");
    } finally {
      setBusy(false);
    }
  }

  const ready = s !== null;
  const dirty = ready && saved !== snap(form, useGo);
  const field = (key: (typeof FIELDS)[number], label: string, help?: string, type: "text" | "number" = "text", step?: string) => (
    <label>
      {label}
      <input type={type} step={step} min={type === "number" ? 0 : undefined} value={form[key] ?? ""} disabled={!ready || busy} required onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
      {help && <span className="muted field-help">{help}</span>}
    </label>
  );

  return (
    <form onSubmit={save} className="add-item-form">
      <h3>Rollout</h3>
      <label className="checkbox-label">
        <input type="checkbox" checked={useGo} disabled={!ready || busy} onChange={(e) => setUseGo(e.target.checked)} />
        Use the GO contract for new contracts
      </label>
      <span className="muted field-help">
        On: the next contract prepared for a booking is the GO contract (the three-page form), with the wording under Contract terms. Off: the original layout with the policy text.
        A contract that already has a link keeps whatever it was; nothing already sent changes.
      </span>

      <h3>Company, as printed on the contract</h3>
      <div className="field-row">
        {field("contractCompanyName", "Company name")}
        {field("contractPhone", "Contract phone", "Printed in the header. Separate from the texting number.")}
      </div>
      {field("contractAddressLine", "Address line")}
      <div className="field-row">
        {field("contractEmail", "Email")}
        {field("contractWebsite", "Website")}
      </div>
      {field("contractFooterLine", "Footer line", "Printed at the foot of every page.")}
      <div className="detail-field">
        <span className="detail-field-label">Logo</span>
        <div className="logo-row">
          <img key={logoBump} src={`/api/contracts/logo.png?b=${logoBump}`} alt="Contract logo as it prints" className="contract-logo-preview" />
          <PhotoDropZone value={null} alt="Contract logo" compact onPhoto={(dataUrl) => setLogo(dataUrl)} disabled={!ready || busy} />
          {s?.contractLogoSet && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setLogo(null)}>
              Use the placeholder
            </button>
          )}
        </div>
        <span className="muted field-help">{s?.contractLogoSet ? "An uploaded logo is in use." : "The built-in placeholder is in use until a logo is uploaded."}</span>
      </div>

      <h3>Numbers the wording binds to</h3>
      <p className="muted settings-help">
        The retainer percentage ({s ? `${s.depositPercentage}%` : "…"}) and the cancellation window ({s ? `${s.cancellationWindowDays} days` : "…"}) are under Business rules and are used here as they are.
      </p>
      <div className="field-row">
        {field("balanceDueDays", "Balance due (days before the event)", undefined, "number", "1")}
        {field("signAndPayWindowDays", "Sign and pay by (days after sending)", "Sets the date printed in the header.", "number", "1")}
      </div>
      <div className="field-row">
        {field("rescheduleFeePercent", "Reschedule fee (%)", undefined, "number", "0.01")}
        {field("outsidePlannerChargePercent", "Outside planner charge (%)", undefined, "number", "0.01")}
        {field("returnedCheckFee", "Returned check fee ($)", undefined, "number", "0.01")}
      </div>
      {error && <p className="form-error">{error}</p>}
      {message && <p className="bulk-result">{message}</p>}
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
