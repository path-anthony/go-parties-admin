import { prisma } from "./db.js";

// Block F1. Paid means Confirmed. A booking that needs no contract (the
// rental policy path: tier 1, still at Held) becomes Confirmed the moment its
// retainer is paid, and that moment is stored. A contract booking is
// Confirmed when it is Signed and paid, which displayStatus already reads
// from the stage and the retainer flag, so nothing is stored for it.
//
// Called only when the retainer has just become paid (a Stripe payment, a
// payment staff recorded, or staff ticking Retainer paid). A booking paid
// before Block F1 is never touched by this on its own.

export function confirmsOnPayment(b: { status: string; tier: number | null; retainerPaid: boolean; confirmedAt: Date | null }): boolean {
  return b.retainerPaid && b.confirmedAt === null && b.tier === 1 && b.status === "Held";
}

// Returns true when this call confirmed the booking. Safe to run twice: the
// update only applies while confirmedAt is still empty.
export async function confirmIfPaid(bookingId: string, now = new Date()): Promise<boolean> {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { status: true, tier: true, retainerPaid: true, confirmedAt: true } });
  if (!b || !confirmsOnPayment(b)) return false;
  const won = await prisma.booking.updateMany({ where: { id: bookingId, confirmedAt: null, retainerPaid: true, status: "Held", tier: 1 }, data: { confirmedAt: now } });
  return won.count === 1;
}
