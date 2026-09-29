// The flag on a booking made, or moved, inside the minimum notice window.
// Solid and loud on purpose: the person reading a list should not have to
// look for it. Hidden on a cancelled booking, where it no longer matters.
export function RushTag({ rush, cancelled = false }: { rush: boolean; cancelled?: boolean }) {
  if (!rush || cancelled) return null;
  return (
    <span className="rush-tag" title="Rush: booked inside the minimum notice window. Confirm with the customer.">
      RUSH
    </span>
  );
}
