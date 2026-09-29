import { useState } from "react";
import { BILLED_PER_OPTIONS, MAX_BILLED_PER_OTHER, billedPerOption } from "../lib/itemFields";

const OTHER = "__other__";

// "Billed per" is how the price reads to a customer, so it is a short
// dropdown, not a text box. The five common choices, then Other, which
// reveals a short label (30 characters, no sentences).
//
// The picker is controlled by value (the stored text, "" for none) and
// reports two kinds of change so a caller can save on the right one:
// onSelect for a pick from the dropdown (final, save now), onText for
// typing in the Other box (a draft) with onTextCommit when the box is left.
// A stored value that isn't on the list (older free text) opens straight
// into Other with that text, so nothing is hidden or rewritten.
export function BilledPerPicker({
  value,
  onSelect,
  onText,
  onTextCommit,
  disabled,
  ariaLabel,
}: {
  value: string;
  onSelect: (value: string) => void;
  onText: (value: string) => void;
  onTextCommit?: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const [otherMode, setOtherMode] = useState(() => value.trim() !== "" && billedPerOption(value) === null);
  const option = billedPerOption(value);
  const selectValue = otherMode ? OTHER : (option ?? "");

  function handleSelect(next: string) {
    if (next === OTHER) {
      // Keep whatever is stored as the starting text; nothing is saved
      // until the text is changed and the box is left.
      setOtherMode(true);
      return;
    }
    setOtherMode(false);
    onSelect(next);
  }

  function handleTextBlur(text: string) {
    const trimmed = text.trim();
    // Left on a listed value or emptied: fall back to the dropdown.
    if (trimmed === "" || billedPerOption(trimmed) !== null) setOtherMode(false);
    onTextCommit?.(trimmed);
  }

  return (
    <label className="billed-per-picker">
      Billed per
      <select value={selectValue} onChange={(e) => handleSelect(e.target.value)} disabled={disabled} aria-label={ariaLabel}>
        <option value="">Not set</option>
        {BILLED_PER_OPTIONS.map((label) => (
          <option key={label} value={label}>
            {label}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {otherMode && (
        <input
          value={value}
          maxLength={MAX_BILLED_PER_OTHER}
          onChange={(e) => onText(e.target.value)}
          onBlur={(e) => handleTextBlur(e.target.value)}
          placeholder="Short label, e.g. Per 2 hours"
          aria-label={`${ariaLabel}, other`}
          disabled={disabled}
        />
      )}
      <span className="muted field-help">
        How the price reads to a customer. Not the number of units.
        {otherMode ? ` Up to ${MAX_BILLED_PER_OTHER} characters; longer notes belong in Notes.` : ""}
      </span>
    </label>
  );
}
