// Block F3b. The items on a booking as short lines, "Grand Tent x 2", built
// the same way for the pay link, the Bookings list and the booking popup.
// A physical item is counted by the units held; a service item (crew, no
// unit) by its gigs, one per skill per unit wanted.

export type ItemLine = { name: string; quantity: number };

export function bookingItemLines(units: { unit: { item: { name: string } } }[], gigs: { itemName: string; skill?: string | null; status?: string | null }[]): ItemLine[] {
  const lines = new Map<string, number>();
  for (const u of units) lines.set(u.unit.item.name, (lines.get(u.unit.item.name) ?? 0) + 1);
  const crew = new Map<string, Map<string, number>>();
  for (const g of gigs) {
    if (g.status === "Cancelled" || lines.has(g.itemName)) continue;
    const bySkill = crew.get(g.itemName) ?? new Map<string, number>();
    bySkill.set(g.skill ?? "", (bySkill.get(g.skill ?? "") ?? 0) + 1);
    crew.set(g.itemName, bySkill);
  }
  for (const [name, bySkill] of crew) lines.set(name, Math.max(...bySkill.values()));
  return [...lines].map(([name, quantity]) => ({ name, quantity }));
}

// "Grand Tent x 2, Photo Booth and 1 more"
export function itemsBrief(lines: ItemLine[], packageName: string | null, max = 2): string {
  if (packageName) return packageName;
  if (lines.length === 0) return "No items";
  const said = lines.slice(0, max).map((l) => (l.quantity > 1 ? `${l.name} x ${l.quantity}` : l.name));
  return lines.length > max ? `${said.join(", ")} and ${lines.length - max} more` : said.join(", ");
}
