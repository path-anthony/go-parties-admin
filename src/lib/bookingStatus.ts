// A booking's status, in one place for the server and the screens.
//
// Two things are stored on a booking: a stage the admin sets by hand
// (Held, Contract Sent, Signed, plus Completed and Cancelled) and a
// Retainer paid flag the admin ticks by hand. The status people read is
// computed from them. Confirmed is never stored and never set directly:
// it is what a booking is when it is Signed and the retainer is paid.

export const BOOKING_STAGES = ["Held", "Contract Sent", "Signed", "Completed", "Cancelled"] as const;
export type BookingStage = (typeof BOOKING_STAGES)[number];

export const DISPLAY_STATUSES = ["Held", "Contract Sent", "Signed", "Retainer Paid", "Confirmed", "Completed", "Cancelled"] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export function displayStatus(booking: { status: string; retainerPaid: boolean }): DisplayStatus {
  const { status, retainerPaid } = booking;
  if (status === "Cancelled") return "Cancelled";
  if (status === "Completed") return "Completed";
  if (status === "Signed" && retainerPaid) return "Confirmed";
  if (retainerPaid) return "Retainer Paid";
  return (BOOKING_STAGES as readonly string[]).includes(status) ? (status as DisplayStatus) : "Held";
}

// The status the storefront's portal has always read: "Confirmed" meant a
// live booking, so it still does until the storefront reads displayStatus.
export function legacyCustomerStatus(status: string): "Confirmed" | "Completed" | "Cancelled" {
  return status === "Cancelled" ? "Cancelled" : status === "Completed" ? "Completed" : "Confirmed";
}
