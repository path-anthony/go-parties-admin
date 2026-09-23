import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { importBulkItems, previewBulkItems } from "../lib/api";
import type { BulkPreview, BulkSummary } from "../lib/types";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

// Bulk add in three steps inside one popup: pick a file (or download the
// template), read the preview (every row, every problem named, nothing
// written yet), then create. Rows with a problem are shown and skipped,
// never dropped quietly; fix the file and upload again to include them.
export function BulkAddModal({ onClose, onImported }: { onClose: () => void; onImported: (summary: BulkSummary) => Promise<void> }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [summary, setSummary] = useState<BulkSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setSummary(null);
    setBusy(true);
    try {
      const text = await file.text();
      setFileName(file.name);
      setCsv(text);
      setPreview(await previewBulkItems(text));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    if (!csv) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importBulkItems(csv);
      setSummary(result);
      setPreview(null);
      await onImported(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the items");
    } finally {
      setBusy(false);
    }
  }

  const bad = preview ? preview.rows.filter((r) => r.problems.length > 0) : [];

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Bulk add items" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Bulk add items</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={16} />
          </button>
        </div>

        {!summary && (
          <div className="bulk-drop">
            <p className="muted addon-help">
              One item per row: name, category, price, billed_per, skills (comma-separated, blank for a physical item),
              starting_units (blank means 1, ignored when skills are set), notes. Categories match existing ones regardless
              of case; a new one is created as typed. A name already in the catalog is skipped.
            </p>
            <div className="form-actions">
              <a className="btn-secondary" href="/api/items/bulk/template.csv" download="items-bulk-template.csv">
                Download template
              </a>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                aria-label="CSV file to import"
                onChange={(e) => handleFile(e.target.files?.[0])}
                disabled={busy}
              />
            </div>
            {fileName && <span className="muted">{fileName}</span>}
          </div>
        )}

        {error && (
          <p className="form-error booking-notice" role="alert">
            {error}
          </p>
        )}

        {preview && (
          <div className="modal-section">
            <span className="detail-field-label">
              Preview: {preview.creatable} of {preview.rows.length} {preview.rows.length === 1 ? "row" : "rows"} will be created
            </span>
            {preview.missingHeaders.length > 0 && (
              <p className="form-error">
                The file is missing the {preview.missingHeaders.join(", ")} {preview.missingHeaders.length === 1 ? "column" : "columns"}. Download the
                template for the exact headers.
              </p>
            )}
            {bad.length > 0 && (
              <p className="bulk-problem">
                {bad.length} {bad.length === 1 ? "row has a problem and" : "rows have problems and"} will be skipped. Fix the file and upload it again
                to include {bad.length === 1 ? "it" : "them"}.
              </p>
            )}
            {(preview.categoriesNew.length > 0 || preview.categoriesReused.length > 0) && (
              <p className="muted addon-help">
                {preview.categoriesReused.length > 0 && `Existing categories reused: ${preview.categoriesReused.join(", ")}. `}
                {preview.categoriesNew.length > 0 && `New categories to be created: ${preview.categoriesNew.join(", ")}.`}
              </p>
            )}
            <div className="bulk-table-wrap">
              <table className="bulk-table">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Name</th>
                    <th>Category</th>
                    <th>Price</th>
                    <th>Billed per</th>
                    <th>Skills</th>
                    <th>Units</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.line} className={row.problems.length > 0 ? "bulk-row-bad" : ""}>
                      <td className="muted">{row.line}</td>
                      <td>{row.name || <span className="muted">(blank)</span>}</td>
                      <td>
                        {row.category || <span className="muted">(blank)</span>}
                        {row.category && row.categoryNew && row.problems.length === 0 && <span className="bulk-tag-new">new</span>}
                      </td>
                      <td>{row.price === null ? <span className="muted">--</span> : usd(row.price)}</td>
                      <td className={row.billedPer ? "" : "muted"}>{row.billedPer ?? "--"}</td>
                      <td className={row.skills.length ? "" : "muted"}>{row.skills.length ? row.skills.join(", ") : "None"}</td>
                      <td>{row.skills.length > 0 && row.problems.length === 0 ? <span className="muted">crew</span> : row.startingUnits}</td>
                      <td>
                        {row.problems.length === 0 ? (
                          <span className="status-pill status-pill-live">Will create</span>
                        ) : (
                          <span className="bulk-problem">Skip: {row.problems.join("; ")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-actions">
              <button type="button" className="btn-primary" disabled={busy || preview.creatable === 0} onClick={handleImport}>
                {busy ? "Adding…" : `Add ${preview.creatable} ${preview.creatable === 1 ? "item" : "items"}`}
              </button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {summary && (
          <div className="modal-section bulk-summary">
            <span className="detail-field-label">Done</span>
            <p>
              <strong>{summary.created}</strong> {summary.created === 1 ? "item" : "items"} created
              {summary.categoriesNew.length > 0 && `, with ${summary.categoriesNew.length === 1 ? "a new category" : "new categories"}: ${summary.categoriesNew.join(", ")}`}
              {summary.categoriesReused.length > 0 && `. Existing categories used: ${summary.categoriesReused.join(", ")}`}.
            </p>
            {summary.skipped.length === 0 ? (
              <p className="muted">Nothing was skipped.</p>
            ) : (
              <>
                <p className="bulk-problem">
                  {summary.skipped.length} {summary.skipped.length === 1 ? "row was" : "rows were"} skipped:
                </p>
                <ul>
                  {summary.skipped.map((s) => (
                    <li key={s.line}>
                      Line {s.line}, {s.name || "(no name)"}: {s.reasons.join("; ")}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="form-actions">
              <button type="button" className="btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
