import { type FormEvent, useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import {
  createAddon,
  createAddonGroup,
  createUnitsBulk,
  deleteAddon,
  deleteAddonGroup,
  deleteItem,
  deleteUnit,
  getItemUsage,
  updateAddon,
  updateAddonGroup,
  updateItem,
  type ItemPatch,
} from "../lib/api";
import { deltaLabel } from "../lib/addons";
import { isUploadedPhoto } from "../lib/photo";
import { UNIT_STATUSES, type AddonGroup, type Item, type ItemDeleteResult, type ItemUsage, type Unit, type UnitStatus } from "../lib/types";
import { AddItemForm } from "./AddItemForm";
import { EditableCell } from "./EditableCell";
import { PhotoDropZone } from "./PhotoDropZone";

// Create and edit live in a popup, the same pattern as the package builder.
// A new item is a form with one Add button. Once it exists (or when an
// existing row is opened) every field saves on its own as it's left, the
// way the expanded row used to, and the item's add-on groups are managed
// underneath. A new item flips into that second mode as soon as it's added,
// because add-ons need an item to belong to.
export function ItemModal({
  item,
  units,
  categories,
  skills,
  onClose,
  onCreated,
  onItemUpdated,
  onUnitsAdded,
  onUnitRemoved,
  onDeleted,
}: {
  item: Item | null;
  // This item's units, from the screen's list.
  units: Unit[];
  // Every category in use, for the new-item form's picker.
  categories: string[];
  // The skill names from Settings, for the checkboxes.
  skills: string[];
  onClose: () => void;
  onCreated: (item: Item) => void;
  onItemUpdated: (item: Item) => void;
  onUnitsAdded: () => Promise<void>;
  onUnitRemoved: (unitId: string) => void;
  onDeleted: (item: Item, result: ItemDeleteResult) => void;
}) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      // In a field, Escape leaves the field (which saves it) rather than
      // closing the popup out from under an edit. A second Escape closes.
      const target = e.target;
      if (target instanceof HTMLElement && target.matches("input, textarea, select")) {
        target.blur();
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={item ? `Edit ${item.name}` : "New item"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{item ? item.name : "New item"}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {item ? (
          <>
            <ItemDetail item={item} skillNames={skills} onItemUpdated={onItemUpdated} />
            <UnitsSection item={item} units={units} onUnitsAdded={onUnitsAdded} onUnitRemoved={onUnitRemoved} />
            <AddonsSection item={item} onItemUpdated={onItemUpdated} />
            <div className="modal-foot">
              <div className="form-actions">
                <button type="button" className="btn-primary" onClick={onClose}>
                  Done
                </button>
                <span className="muted">Changes save as you go.</span>
              </div>
              <DeleteItemControl item={item} onDeleted={onDeleted} />
            </div>
          </>
        ) : (
          <>
            <AddItemForm categories={categories} skillNames={skills} onAdded={onCreated} onCancel={onClose} />
            <div className="modal-section">
              <span className="detail-field-label">Add-ons</span>
              <p className="muted">Add the item first. Its add-on groups and options are set up right after, here.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ItemDetail({ item, skillNames, onItemUpdated }: { item: Item; skillNames: string[]; onItemUpdated: (item: Item) => void }) {
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
        <span className="detail-field-label">Billed per</span>
        <EditableCell
          value={item.priceUnit ?? ""}
          placeholder="e.g. day, event, hour"
          ariaLabel={`Billed per, for ${item.name}`}
          onSave={(priceUnit) => save({ priceUnit })}
        />
        <span className="muted field-help">How the price reads to a customer ("per day"). Not the number of units, which is below.</span>
      </div>
      <div className="detail-field detail-field-span">
        <span className="detail-field-label">Crew skills needed</span>
        <div className="skill-grid" role="group" aria-label={`Crew skills needed for ${item.name}`}>
          {skillNames.length === 0 && <span className="muted">No skills yet. Add them under Settings.</span>}
          {skillNames.map((skill) => (
            <label key={skill} className="checkbox-label">
              <input
                type="checkbox"
                checked={item.skills.includes(skill)}
                onChange={(e) =>
                  save({
                    skills: e.target.checked
                      ? [...new Set([...item.skills, skill])]
                      : item.skills.filter((s) => s !== skill),
                  })
                }
              />
              {skill}
            </label>
          ))}
        </div>
        <span className="muted field-help">
          Every person this item needs to run, one gig each when it's booked. Independent of units: an item can be a physical
          piece, a service, or both.
        </span>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <PhotoDropZone
        value={item.photoUrl}
        alt={`Photo for ${item.name}`}
        onPhoto={(photoUrl) => onSave({ photoUrl })}
        disabled={busy}
      />
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

// The item's physical units: how many can be out on one date. Each row is
// one real piece with its own label and status; the count is the number
// of rows. Adding goes through the same bulk call the Inventory toolbar
// uses; removing is refused while a live booking holds the unit.
function UnitsSection({
  item,
  units,
  onUnitsAdded,
  onUnitRemoved,
}: {
  item: Item;
  units: Unit[];
  onUnitsAdded: () => Promise<void>;
  onUnitRemoved: (unitId: string) => void;
}) {
  const [quantity, setQuantity] = useState(1);
  // Default the pattern to the item's own naming ("Bar #1" when its units
  // are Bar #1, Bar #2), so an added unit continues the sequence.
  const [labelPattern, setLabelPattern] = useState(() => {
    const first = units[0]?.label.match(/^(.*?)\s*#?\d+$/);
    return first ? `${first[1].trim()} #1` : "Unit #1";
  });
  const [status, setStatus] = useState<UnitStatus>("Available");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-section">
      <span className="detail-field-label">Units</span>
      <p className="muted addon-help">
        How many of this item can be out on one date. Each unit is one real piece. An item with no units and no crew skills
        can't be booked from the storefront.
      </p>
      {units.length === 0 ? (
        <p className="muted">No units. {item.skills.length > 0 ? "It's covered by crew alone." : "Add at least one so it can be booked."}</p>
      ) : (
        <ul className="addon-list">
          {units.map((unit) => (
            <li key={unit.id} className="unit-row">
              <span>
                <strong>{unit.label}</strong> <span className="muted">· {unit.status}</span>
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${unit.label} from ${item.name}`}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await deleteUnit(unit.id);
                    onUnitRemoved(unit.id);
                  }, "Couldn't remove the unit")
                }
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="unit-add"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await createUnitsBulk({ itemIds: [item.id], labelPattern, quantity, status });
            await onUnitsAdded();
          }, "Couldn't add units");
        }}
      >
        <input
          type="number"
          min={1}
          max={50}
          value={quantity}
          aria-label={`How many units to add to ${item.name}`}
          onChange={(e) => setQuantity(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
          disabled={busy}
        />
        <input
          value={labelPattern}
          onChange={(e) => setLabelPattern(e.target.value)}
          placeholder="Label pattern, e.g. Cart #1"
          aria-label={`Label pattern for new units of ${item.name}`}
          disabled={busy}
          required
        />
        <select value={status} onChange={(e) => setStatus(e.target.value as UnitStatus)} aria-label="Status for new units" disabled={busy}>
          {UNIT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" className="btn-secondary" disabled={busy}>
          Add {quantity === 1 ? "unit" : `${quantity} units`}
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

// Deleting an item is a real delete, so it goes through a confirmation
// that says exactly what it will touch: every package that lists the item
// (Draft or Published), which of those would be left empty and so taken
// off the storefront, and whether live bookings hold the item's units, in
// which case the server refuses and this says so instead of offering a
// confirm button. The usage is fetched fresh when the confirmation opens,
// not guessed from what the screen has loaded.
function DeleteItemControl({ item, onDeleted }: { item: Item; onDeleted: (item: Item, result: ItemDeleteResult) => void }) {
  const [usage, setUsage] = useState<ItemUsage | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openConfirmation() {
    setBusy(true);
    setError(null);
    try {
      setUsage(await getItemUsage(item.id));
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't check where this item is used");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      onDeleted(item, await deleteItem(item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the item");
      setBusy(false);
    }
  }

  if (!open || !usage) {
    return (
      <div className="form-actions">
        <button type="button" className="btn-secondary btn-danger" onClick={openConfirmation} disabled={busy}>
          {busy ? "Checking…" : "Delete item"}
        </button>
        {error && <span className="form-error">{error}</span>}
      </div>
    );
  }

  const blocked = usage.heldByBookings > 0;
  const emptied = usage.packages.filter((pkg) => pkg.status === "Published" && pkg.itemCount <= 1);
  const stillLive = usage.packages.filter((pkg) => pkg.status === "Published" && pkg.itemCount > 1);
  const drafts = usage.packages.filter((pkg) => pkg.status !== "Published");

  return (
    <div className="modal-section" role="alertdialog" aria-label={`Delete ${item.name}?`}>
      <strong>Delete {item.name} for good?</strong>

      {blocked && (
        <p className="form-error">
          It can't be deleted yet: {usage.heldByBookings} {usage.heldByBookings === 1 ? "booking that isn't" : "bookings that aren't"}{" "}
          cancelled {usage.heldByBookings === 1 ? "holds" : "hold"} one of its units. Remove it from those bookings in
          Scheduling, or cancel them, then try again. Nothing was changed.
        </p>
      )}

      {!blocked && usage.packages.length === 0 && (
        <p className="muted">It isn't in any package and no booking holds it, so nothing else is affected.</p>
      )}

      {!blocked && usage.packages.length > 0 && (
        <>
          <p className="muted">
            It will be removed from {usage.packages.length} {usage.packages.length === 1 ? "package" : "packages"}:
          </p>
          <ul className="addon-list">
            {stillLive.map((pkg) => (
              <li key={pkg.id}>
                <strong>{pkg.name}</strong> <span className="muted">· published, keeps its other items and stays live</span>
              </li>
            ))}
            {emptied.map((pkg) => (
              <li key={pkg.id}>
                <strong>{pkg.name}</strong>{" "}
                <span className="form-error">
                  · published, this is its only item, so it will be unpublished (kept as a draft, taken off the storefront)
                </span>
              </li>
            ))}
            {drafts.map((pkg) => (
              <li key={pkg.id}>
                <strong>{pkg.name}</strong> <span className="muted">· draft</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="form-actions">
        {!blocked && (
          <button type="button" className="btn-secondary btn-danger" onClick={confirm} disabled={busy}>
            {busy ? "Deleting…" : "Yes, delete"}
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
          {blocked ? "Close" : "Keep it"}
        </button>
        {error && <span className="form-error">{error}</span>}
      </div>
    </div>
  );
}

// Add-on groups for one item. Everything saves as it happens, like the
// fields above: names and price changes on blur, the rest on click.
function AddonsSection({ item, onItemUpdated }: { item: Item; onItemUpdated: (item: Item) => void }) {
  const [name, setName] = useState("");
  const [required, setRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = item.addonGroups;

  function replaceGroup(updated: AddonGroup) {
    onItemUpdated({ ...item, addonGroups: groups.map((g) => (g.id === updated.id ? updated : g)) });
  }

  function removeGroup(id: string) {
    onItemUpdated({ ...item, addonGroups: groups.filter((g) => g.id !== id) });
  }

  async function handleAddGroup(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const group = await createAddonGroup({ itemId: item.id, name, required });
      onItemUpdated({ ...item, addonGroups: [...groups, group] });
      setName("");
      setRequired(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the group");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-section">
      <span className="detail-field-label">Add-ons</span>
      <p className="muted addon-help">
        A group is one choice about this item, like Flavor or Print size. A customer picks one option per group. Required
        groups have to be answered to book; the rest are optional upgrades. A price change can be zero or negative.
      </p>

      {groups.length === 0 && <p className="muted">No add-on groups yet.</p>}
      {groups.map((group) => (
        <AddonGroupCard key={group.id} group={group} itemName={item.name} onChanged={replaceGroup} onDeleted={removeGroup} />
      ))}

      <form className="addon-new-group" onSubmit={handleAddGroup}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New group, e.g. Flavor"
          aria-label="New add-on group name"
          maxLength={80}
          disabled={saving}
        />
        <label className="checkbox-label">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} disabled={saving} />
          Required
        </label>
        <button type="submit" className="btn-secondary" disabled={saving || name.trim() === ""}>
          Add group
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

// Advisory only. A customer picks one option from this list, usually on a
// phone, and past about eight it stops being something you can scan. The
// note shows once a group goes over this; nothing is blocked (the server's
// own hard cap is far higher and is a separate thing).
const SOFT_MAX_OPTIONS = 8;

function AddonGroupCard({
  group,
  itemName,
  onChanged,
  onDeleted,
}: {
  group: AddonGroup;
  itemName: string;
  onChanged: (group: AddonGroup) => void;
  onDeleted: (id: string) => void;
}) {
  const [optionName, setOptionName] = useState("");
  const [optionDelta, setOptionDelta] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // For the controls that act on click; the text fields use EditableCell,
  // which carries its own saving state.
  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function handleAddOption(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      onChanged(await createAddon(group.id, { name: optionName, priceDelta: optionDelta }));
      setOptionName("");
      setOptionDelta("");
    }, "Couldn't add the option");
  }

  return (
    <div className="addon-group">
      <div className="addon-group-head">
        <EditableCell
          value={group.name}
          ariaLabel={`Name of the ${group.name} group for ${itemName}`}
          onSave={async (value) => onChanged(await updateAddonGroup(group.id, { name: value }))}
        />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={group.required}
            disabled={busy}
            onChange={(e) =>
              run(async () => onChanged(await updateAddonGroup(group.id, { required: e.target.checked })), "Couldn't save")
            }
          />
          Required
        </label>
        {confirmingDelete ? (
          <span className="addon-confirm">
            <span className="muted">Delete {group.name} and its options?</span>
            <button
              type="button"
              className="btn-secondary btn-danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await deleteAddonGroup(group.id);
                  onDeleted(group.id);
                }, "Couldn't delete the group")
              }
            >
              Yes, delete
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirmingDelete(false)}>
              Keep it
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Delete the ${group.name} group`}
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {group.addons.length === 0 ? (
        <p className="muted addon-empty">
          No options yet.{group.required ? " A required group with no options is ignored until it has one." : ""}
        </p>
      ) : (
        <ul className="addon-list">
          {group.addons.map((addon) => (
            <li key={addon.id} className="addon-row">
              <EditableCell
                value={addon.name}
                ariaLabel={`Name of the ${addon.name} option in ${group.name}`}
                onSave={async (value) => onChanged(await updateAddon(group.id, addon.id, { name: value }))}
              />
              <span className="addon-delta">
                <span className="addon-delta-prefix">$</span>
                <EditableCell
                  type="number"
                  value={String(Number(addon.priceDelta))}
                  placeholder="0"
                  ariaLabel={`Price change for ${addon.name} in ${group.name}`}
                  onSave={async (value) => onChanged(await updateAddon(group.id, addon.id, { priceDelta: value }))}
                />
              </span>
              <span className="addon-delta-label muted">{deltaLabel(addon.priceDelta) || "No change"}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove the ${addon.name} option from ${group.name}`}
                disabled={busy}
                onClick={() => run(async () => onChanged(await deleteAddon(group.id, addon.id)), "Couldn't remove the option")}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {group.addons.length > SOFT_MAX_OPTIONS && (
        <p className="addon-advice" role="note">
          {group.addons.length} options is a long list to pick one from, especially on a phone. {group.name} might work
          better split into two groups, or with a few options trimmed. This is only a suggestion, everything here still
          saves.
        </p>
      )}

      <form className="addon-new-option" onSubmit={handleAddOption}>
        <input
          value={optionName}
          onChange={(e) => setOptionName(e.target.value)}
          placeholder="New option, e.g. Peach"
          aria-label={`New option name for ${group.name}`}
          maxLength={80}
          disabled={busy}
        />
        <span className="addon-delta">
          <span className="addon-delta-prefix">$</span>
          <input
            type="number"
            step="0.01"
            value={optionDelta}
            onChange={(e) => setOptionDelta(e.target.value)}
            placeholder="0"
            aria-label={`Price change for the new ${group.name} option`}
            disabled={busy}
          />
        </span>
        <button type="submit" className="btn-secondary" disabled={busy || optionName.trim() === ""}>
          Add option
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
