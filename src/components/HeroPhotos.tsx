import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { deleteHeroSlide, getHeroSlides, moveHeroSlide, updateHeroSlide, uploadHeroSlide } from "../lib/api";
import type { HeroSlide } from "../lib/types";
import { EditableCell } from "./EditableCell";

// Block A6. The photos that rotate at the top of the store's Home page, in
// order. Text buttons only. Delete asks in the row, not with a browser
// dialog. Several files can be chosen at once; each is sent on its own so
// one bad file does not stop the rest.
export function HeroPhotos() {
  const [slides, setSlides] = useState<HeroSlide[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getHeroSlides()
      .then(setSlides)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the photos"));
  }, []);

  async function act(fn: () => Promise<HeroSlide[]>) {
    setBusy(true);
    setError(null);
    try {
      setSlides(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save");
    } finally {
      setBusy(false);
    }
  }

  async function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    const problems: string[] = [];
    for (const [i, file] of files.entries()) {
      setUploading(`Uploading ${i + 1} of ${files.length}: ${file.name}`);
      try {
        await uploadHeroSlide(file);
      } catch (err) {
        problems.push(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`);
      }
    }
    setUploading(null);
    try {
      setSlides(await getHeroSlides());
    } catch (err) {
      problems.push(err instanceof Error ? err.message : "Couldn't reload the photos");
    }
    if (problems.length > 0) setError(problems.join(" "));
    setBusy(false);
  }

  const list = slides ?? [];
  return (
    <div className="status-control" role="group" aria-label="Home photos">
      <p className="muted settings-help">These photos rotate at the top of your store's Home page. Use wide, bright photos of real events. 3 to 6 works best.</p>
      <div className="form-actions">
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic" multiple onChange={handleFiles} style={{ display: "none" }} aria-label="Choose photos" />
        <button type="button" className="btn-primary" disabled={busy || slides === null} onClick={() => inputRef.current?.click()}>
          Add photos
        </button>
        {uploading && <span className="muted">{uploading}</span>}
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
      </div>
      {slides && list.length === 0 && <span className="muted">No photos yet. The Home page shows its built-in photos until you add some.</span>}
      {list.length > 0 && (
        <ol className="addon-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {list.map((s, i) => (
            <li key={s.id} className="unit-row" style={{ alignItems: "flex-start", gap: 12, padding: "10px 0" }}>
              <img src={s.thumbnailUrl} alt={s.altText} width={160} style={{ width: 160, height: "auto", borderRadius: 6, flex: "0 0 160px", opacity: s.active ? 1 : 0.45 }} />
              <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 6 }}>
                <span className="muted">
                  {i + 1} of {list.length} · {s.width} × {s.height} · {s.active ? "Shown" : "Hidden"}
                </span>
                <label>
                  <span className="detail-field-label">Alt text (short description, required)</span>
                  <EditableCell value={s.altText} placeholder="What is in the photo" ariaLabel={`Alt text for photo ${i + 1}`} onSave={(v) => act(() => updateHeroSlide(s.id, { altText: v }))} />
                </label>
                <div className="form-actions">
                  <button type="button" className="btn-secondary" disabled={busy || i === 0} onClick={() => act(() => moveHeroSlide(s.id, "up"))}>
                    Move up
                  </button>
                  <button type="button" className="btn-secondary" disabled={busy || i === list.length - 1} onClick={() => act(() => moveHeroSlide(s.id, "down"))}>
                    Move down
                  </button>
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(() => updateHeroSlide(s.id, { active: !s.active }))}>
                    {s.active ? "Hide" : "Show"}
                  </button>
                  {confirming !== s.id && (
                    <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(s.id)}>
                      Delete
                    </button>
                  )}
                  {confirming === s.id && (
                    <>
                      <span className="stage-warning" role="note">
                        Delete this photo? It comes off the Home page at once.
                      </span>
                      <button type="button" className="btn-danger" disabled={busy} onClick={() => act(() => deleteHeroSlide(s.id)).then(() => setConfirming(null))}>
                        Yes, delete
                      </button>
                      <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(null)}>
                        Keep it
                      </button>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
