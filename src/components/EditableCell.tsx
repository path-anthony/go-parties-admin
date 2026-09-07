import { useState } from "react";

type Status = "idle" | "saving" | "saved" | "error";

export function EditableCell({
  value,
  onSave,
  type = "text",
  placeholder,
}: {
  value: string;
  onSave: (value: string) => Promise<void>;
  type?: "text" | "number";
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [syncedValue, setSyncedValue] = useState(value);

  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(value);
  }

  async function handleBlur() {
    if (draft === value) {
      if (status === "error") {
        setStatus("idle");
        setError(null);
      }
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      await onSave(draft);
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  return (
    <div className="editable-cell">
      <input
        type={type}
        step={type === "number" ? "0.01" : undefined}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        className={status === "error" ? "cell-input cell-input-error" : "cell-input"}
      />
      {status === "saving" && <span className="cell-status">Saving…</span>}
      {status === "saved" && <span className="cell-status cell-status-saved">Saved</span>}
      {status === "error" && (
        <span className="cell-status cell-status-error" title={error ?? undefined}>
          {error}
        </span>
      )}
    </div>
  );
}
