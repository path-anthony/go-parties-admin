// "+$10", "-$25", or "" for a free choice.
export function deltaLabel(priceDelta: string | number): string {
  const delta = Number(priceDelta);
  if (!Number.isFinite(delta) || delta === 0) return "";
  const cents = Number.isInteger(delta) ? 0 : 2;
  const money = Math.abs(delta).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents,
    maximumFractionDigits: cents,
  });
  return delta > 0 ? `+${money}` : `-${money}`;
}

// "Flavor: Peach (+$10)"
export function describeAddon(addon: { groupName: string; addonName: string; priceDelta: string | number }): string {
  const label = deltaLabel(addon.priceDelta);
  return `${addon.groupName}: ${addon.addonName}${label ? ` (${label})` : ""}`;
}
