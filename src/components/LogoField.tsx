import { useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/api";
import { EDITOR_COPY } from "../settingsCopy";
import { PhotoDropZone } from "./PhotoDropZone";

// Block A12: the contract logo, on its own now that the rest of the contract
// details moved. It saves the moment a picture is chosen, as it always did.
export function LogoField() {
  const [isSet, setIsSet] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logoBump, setLogoBump] = useState(0);

  useEffect(() => {
    let current = true;
    getSettings()
      .then((s) => current && setIsSet(s.contractLogoSet))
      .catch((err) => current && setError(err instanceof Error ? err.message : "Couldn't load the settings"));
    return () => {
      current = false;
    };
  }, []);

  async function setLogo(dataUrl: string | null) {
    setBusy(true);
    setError(null);
    try {
      const s = await updateSettings({ contractLogo: dataUrl });
      setIsSet(s.contractLogoSet);
      setLogoBump((n) => n + 1);
      setMessage(dataUrl ? "Logo saved. New contracts and PDFs use it." : "Logo removed. The built-in placeholder is used.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the logo");
    } finally {
      setBusy(false);
    }
  }

  const ready = isSet !== null;
  return (
    <div className="detail-field">
      <div className="logo-row" data-setting="contractLogo">
        <img key={logoBump} src={`/api/contracts/logo.png?b=${logoBump}`} alt="Contract logo as it prints" className="contract-logo-preview" />
        <PhotoDropZone value={null} alt="Contract logo" compact onPhoto={(dataUrl) => setLogo(dataUrl)} disabled={!ready || busy} />
        {isSet && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setLogo(null)}>
            Use the placeholder
          </button>
        )}
      </div>
      <span className="muted field-help">{EDITOR_COPY.logo.help}</span>
      <span className="muted field-help">{isSet ? EDITOR_COPY.logo.inUse : EDITOR_COPY.logo.placeholder}</span>
      {error && <p className="form-error">{error}</p>}
      {message && <p className="bulk-result">{message}</p>}
    </div>
  );
}
