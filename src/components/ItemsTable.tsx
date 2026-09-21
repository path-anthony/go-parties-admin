import type { KeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { Item } from "../lib/types";

function priceLabel(item: Item): string {
  if (item.price === null) return "TBD";
  const amount = Number(item.price).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return item.priceUnit ? `${amount} · ${item.priceUnit}` : amount;
}

function addonsLabel(item: Item): string {
  const count = item.addonGroups.length;
  if (count === 0) return "None";
  return `${count} ${count === 1 ? "group" : "groups"}`;
}

// A compact list. Clicking a row opens the item's popup, where every field
// and the item's add-ons are edited.
export function ItemsTable({
  items,
  onOpen,
  selected,
  onToggleSelect,
  onSelectAll,
  unitCounts,
}: {
  items: Item[];
  onOpen: (id: string) => void;
  selected: Set<string>;
  onToggleSelect: (id: string, checked: boolean) => void;
  onSelectAll: (ids: string[], checked: boolean) => void;
  unitCounts: Map<string, number>;
}) {
  const visibleIds = items.map((item) => item.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = !allSelected && visibleIds.some((id) => selected.has(id));

  return (
    <table className="items-table catalog-table">
      <thead>
        <tr>
          <th className="catalog-select-cell">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected;
              }}
              onChange={(e) => onSelectAll(visibleIds, e.target.checked)}
              aria-label="Select all listed items"
            />
          </th>
          <th aria-label="Photo" />
          <th>Name</th>
          <th>Category</th>
          <th>Price</th>
          <th>Units</th>
          <th>Add-ons</th>
          <th aria-label="Open" />
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            onOpen={() => onOpen(item.id)}
            isSelected={selected.has(item.id)}
            onToggleSelect={(checked) => onToggleSelect(item.id, checked)}
            unitCount={unitCounts.get(item.id) ?? 0}
          />
        ))}
      </tbody>
    </table>
  );
}

function ItemRow({
  item,
  onOpen,
  isSelected,
  onToggleSelect,
  unitCount,
}: {
  item: Item;
  onOpen: () => void;
  isSelected: boolean;
  onToggleSelect: (checked: boolean) => void;
  unitCount: number;
}) {
  function handleKey(e: KeyboardEvent<HTMLTableRowElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  }

  return (
    <tr
      className={isSelected ? "catalog-row catalog-row-selected" : "catalog-row"}
      onClick={onOpen}
      onKeyDown={handleKey}
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={`Open ${item.name}`}
    >
      {/* The checkbox sits inside the click-to-open row, so it stops the
          click from reaching the row. */}
        <td className="catalog-select-cell" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(e) => onToggleSelect(e.target.checked)}
            aria-label={`Select ${item.name}`}
          />
        </td>
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
        <td className={unitCount === 0 ? "muted" : ""}>{unitCount === 0 ? "None" : unitCount}</td>
      <td className={item.addonGroups.length === 0 ? "muted" : ""}>{addonsLabel(item)}</td>
      <td className="catalog-chevron">
        <ChevronRight size={14} />
      </td>
    </tr>
  );
}
