import { displayStatus } from "../lib/bookingStatus";

// A booking's status as a solid tag, one colour each, with Confirmed the
// only green so a Held booking can't be mistaken for a settled one. The
// status is computed here from the stored stage and the retainer flag, so
// every screen agrees.
export function BookingStatusTag({ booking }: { booking: { status: string; retainerPaid: boolean } }) {
  const status = displayStatus(booking);
  return <span className={`bstatus bstatus-${status.toLowerCase().replace(/ /g, "-")}`}>{status}</span>;
}
