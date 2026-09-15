import { type ChangeEvent, type DragEvent, type KeyboardEvent, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { updateItem, type ItemPatch } from "../lib/api";
import { compressImage, isUploadedPhoto } from "../lib/photo";
import type { Item } from "../lib/types";
import { EditableCell } from "./EditableCell";

function priceLabel(item: Item): string {
  if (item.price === null) return "TBD";
  const amount = Number(item.price).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return item.priceUnit ? `${amount} · ${item.priceUnit}` : amount;
}

export function ItemsTable({
  items,
  expanded,
  onToggle,
  onItemUpdated,
}: {
  items: Item[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onItemUpdated: (item: Item) => void;
}) {
  return (
    <table className="items-table catalog-table">
      <thead>
        <tr>
          <th aria-label="Photo" />
          <th>Name</th>
          <th>Category</th>
          <th>Price</th>
          <th aria-label="Expand" />
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <ItemRows
            key={item.id}
            item={item}
            expanded={expanded.has(item.id)}
            onToggle={() => onToggle(item.id)}
            onItemUpdated={onItemUpdated}
          />
        ))}
      </tbody>
    </table>
  );
}

function ItemRows({
  item,
  expanded,
  onToggle,
  onItemUpdated,
}: {
  item: Item;
  expanded: boolean;
  onToggle: () => void;
  onItemUpdated: (item: Item) => void;
}) {
  function handleKey(e: KeyboardEvent<HTMLTableRowElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  }

  return (
    <>
      <tr className="catalog-row" onClick={onToggle} onKeyDown={handleKey} tabIndex={0} aria-expanded={expanded}>
        <td className="catalog-thumb-cell">
          {item.photoUrl ? (
            <img className="catalog-thumb" src={item.photoUrl} alt="" />
          ) : (
            <span className="catalog-thumb catalog-thumb-empty" />
          )}
        </td>
        <td className="catalog-name">{item.name}</td>
        <td className="muted">{item.category}</td>
        <td>{priceLabel(item)}</td>
        <td className="catalog-chevron">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
      </tr>
      {expanded && (
        <tr className="catalog-detail-row">
          <td colSpan={5}>
            <ItemDetail item={item} onItemUpdated={onItemUpdated} />
          </td>
        </tr>
      )}
    </>
  );
}

function ItemDetail({ item, onItemUpdated }: { item: Item; onItemUpdated: (item: Item) => void }) {
  async function save(patch: ItemPatch) {
    onItemUpdated(await updateItem(item.id, patch));
  }

  return (
    <div className="catalog-detail">
      <div className="detail-field">
        <span className="detail-field-label">Name</span>
        <EditableCell value={item.name} ariaLabel={`Name for ${item.name}`} onSave={(name) => save({ name })} />
      </div>
      <div className="detail-field">
        <span className="detail-field-label">Category</span>
        <EditableCell
          value={item.category}
          ariaLabel={`Category for ${item.name}`}
          onSave={(category) => save({ category })}
        />
      </div>
      <div className="detail-field">
        <span className="detail-field-label">Price</span>
        <EditableCell
          type="number"
          value={item.price ?? ""}
          placeholder="TBD"
          ariaLabel={`Price for ${item.name}`}
          onSave={(price) => save({ price })}
        />
      </div>
      <div className="detail-field">
        <span className="detail-field-label">Price unit</span>
        <EditableCell
          value={item.priceUnit ?? ""}
          placeholder="e.g. per day"
          ariaLabel={`Price unit for ${item.name}`}
          onSave={(priceUnit) => save({ priceUnit })}
        />
      </div>
      <div className="detail-field detail-field-span">
        <span className="detail-field-label">Notes</span>
        <EditableCell
          multiline
          value={item.notes ?? ""}
          ariaLabel={`Notes for ${item.name}`}
          onSave={(notes) => save({ notes })}
        />
      </div>
      <div className="detail-field detail-field-span">
        <span className="detail-field-label">Photo</span>
        <PhotoField item={item} onSave={save} />
      </div>
    </div>
  );
}

function PhotoField({ item, onSave }: { item: Item; onSave: (patch: ItemPatch) => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ photoUrl: await compressImage(file) });
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

  async function handleRemove() {
    setBusy(true);
    setError(null);
    try {
      await onSave({ photoUrl: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove photo");
    } finally {
      setBusy(false);
    }
  }

  const uploaded = isUploadedPhoto(item.photoUrl);

  return (
    <>
      <div
        className={dragging ? "photo-drop photo-drop-active" : "photo-drop"}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label={`Photo for ${item.name}: drop an image here or press Enter to choose one`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        {item.photoUrl ? (
          <img className="photo-preview" src={item.photoUrl} alt={item.name} />
        ) : (
          <span className="muted">Drop a photo here, or click to choose one</span>
        )}
        {busy && <span className="cell-status">Saving…</span>}
        <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleChoose} />
      </div>
      <div className="photo-actions">
        {uploaded && <span className="muted">Uploaded photo, stored with the item.</span>}
        {!uploaded && (
          <EditableCell
            value={item.photoUrl ?? ""}
            placeholder="https://..."
            ariaLabel={`Photo URL for ${item.name}`}
            onSave={(photoUrl) => onSave({ photoUrl })}
          />
        )}
        {item.photoUrl && (
          <button type="button" className="btn-secondary" onClick={handleRemove} disabled={busy}>
            Remove photo
          </button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
    </>
  );
}
