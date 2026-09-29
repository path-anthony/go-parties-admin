import { useState } from "react";
import { deleteItemsBulk } from "../lib/api";
import type { BulkItemDeleteResult, BulkItemUsage } from "../lib/types";

// The confirmation for deleting a whole selection. It is opened only after
// the usage has been fetched fresh, and it says everything the single
// delete says, for all the items at once: every package the selection
// touches, which Published ones would be left empty and so unpublished,
// and any selected item a live booking holds. A blocked selection has no
// confirm button; the admin can drop the blocked items from the selection
// or cancel. Nothing is skipped silently.
export function BulkDeleteItems({
  usage,
  onDeleted,
  onDropBlocked,
  onCancel,
}: {
  usage: BulkItemUsage;
  onDeleted: (result: BulkItemDeleteResult) => void;
  onDropBlocked: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = usage.items.length;
  const blocked = usage.blocked.length > 0;
  const emptied = usage.packages.filter((pkg) => pkg.status === "Published" && pkg.emptied);
  const stillLive = usage.packages.filter((pkg) => pkg.status === "Published" && !pkg.emptied);
  const drafts = usage.packages.filter((pkg) => pkg.status !== "Published");

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      onDeleted(await deleteItemsBulk(usage.items.map((item) => item.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the items");
      setBusy(false);
    }
  }

  return (
    <div className="bulk-form bulk-delete" role="alertdialog" aria-label={`Delete ${count} items?`}>
      <strong>
        Delete {count} {count === 1 ? "item" : "items"} for good?
      </strong>

      {blocked && (
        <div className="form-error" role="alert">
          <p>
            It can't go ahead: {usage.blocked.length} of the selected {usage.blocked.length === 1 ? "item is" : "items are"} on
            bookings that aren't cancelled. Nothing was deleted.
          </p>
          <ul className="addon-list">
            {usage.blocked.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>{" "}
                <span>
                  · on {item.heldByBookings} {item.heldByBookings === 1 ? "booking" : "bookings"} that {item.heldByBookings === 1 ? "isn't" : "aren't"} cancelled
                </span>
              </li>
            ))}
          </ul>
          <p>Remove them from those bookings in Scheduling, or cancel the bookings, or leave them out of the selection.</p>
        </div>
      )}

      {!blocked && usage.packages.length === 0 && (
        <p className="muted">None of them is in a package and no booking holds any of them, so nothing else is affected.</p>
      )}

      {usage.packages.length > 0 && (
        <>
          <p className="muted">
            The selection touches {usage.packages.length} {usage.packages.length === 1 ? "package" : "packages"}:
          </p>
          <ul className="addon-list">
            {stillLive.map((pkg) => (
              <li key={pkg.id}>
                <strong>{pkg.name}</strong>{" "}
                <span className="muted">
                  · published, loses {pkg.selectedCount} of its {pkg.itemCount} items and stays live
                </span>
              </li>
            ))}
            {emptied.map((pkg) => (
              <li key={pkg.id}>
                <strong>{pkg.name}</strong>{" "}
                <span className="form-error">
                  · published, every item in it is selected, so it will be unpublished (kept as a draft, taken off the storefront)
                </span>
              </li>
            ))}
            {drafts.map((pkg) => (
              <li key={pkg.id}>
                <strong>{pkg.name}</strong>{" "}
                <span className="muted">
                  · draft, loses {pkg.selectedCount} of its {pkg.itemCount} items{pkg.emptied ? " and will be empty" : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="form-actions">
        {!blocked && (
          <button type="button" className="btn-secondary btn-danger" onClick={confirm} disabled={busy}>
            {busy ? "Deleting…" : `Yes, delete ${count} ${count === 1 ? "item" : "items"}`}
          </button>
        )}
        {blocked && (
          <button type="button" className="btn-secondary" onClick={() => onDropBlocked(usage.blocked.map((item) => item.id))} disabled={busy}>
            Leave the {usage.blocked.length} blocked out of the selection
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          {blocked ? "Close" : "Keep them"}
        </button>
        {error && <span className="form-error">{error}</span>}
      </div>
    </div>
  );
}
