import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { compressImage } from "../lib/photo";

// Drop or click-to-choose an image, compress it client-side (see
// src/lib/photo.ts), and hand the resulting data URL to onPhoto. The
// parent decides what to do with it: save straight away on an existing
// item, or hold it in form state until submit for a new one.
export function PhotoDropZone({
  value,
  alt,
  onPhoto,
  disabled = false,
  compact = false,
}: {
  value: string | null;
  alt: string;
  onPhoto: (dataUrl: string) => Promise<void> | void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await onPhoto(await compressImage(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    void handleFile(e.dataTransfer.files[0]);
  }

  function handleChoose(e: ChangeEvent<HTMLInputElement>) {
    void handleFile(e.target.files?.[0]);
    e.target.value = "";
  }

  const className = ["photo-drop", dragging ? "photo-drop-active" : "", compact ? "photo-drop-compact" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div
        className={className}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        aria-label={`${alt}: drop an image here or press Enter to choose one`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!disabled) inputRef.current?.click();
          }
        }}
      >
        {value ? (
          <img className="photo-preview" src={value} alt={alt} />
        ) : (
          <span className="muted">Drop a photo here, or click to choose one</span>
        )}
        {busy && <span className="cell-status">Saving…</span>}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleChoose}
          disabled={disabled}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
    </>
  );
}
