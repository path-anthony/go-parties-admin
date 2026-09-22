import { Prisma } from "../src/generated/prisma/client.js";
import { prisma } from "./db.js";

type Tx = Prisma.TransactionClient;

// A service item is a person's time (a DJ, a photographer), never a
// physical piece, so it has no units. Booking it creates a Gig.
export function isServiceItem(item: { requiredSkill: string | null }): boolean {
  return item.requiredSkill !== null;
}

// Thrown inside a transaction when no crew member with the skill is free
// on the date, so the transaction rolls back with nothing written. Caught
// alongside NoFreeUnit wherever bookings are made or moved.
export class NoCrewFree extends Error {
  readonly itemName: string;

  constructor(itemName: string) {
    super(`No crew free for ${itemName}`);
    this.itemName = itemName;
  }
}

// How many more gigs of a skill a date can take: the active crew members
// who have the skill, minus the gigs already needing that skill that day
// (Cancelled ones don't count). Read only; for labels and availability
// checks outside a booking transaction.
export async function crewFreeBySkill(accountId: string, date: string): Promise<Map<string, { crew: number; free: number }>> {
  const [crew, gigs] = await Promise.all([
    prisma.crewMember.findMany({ where: { accountId, active: true }, select: { skills: true } }),
    prisma.gig.groupBy({
      by: ["skill"],
      where: { accountId, eventDate: new Date(`${date}T00:00:00Z`), status: { not: "Cancelled" } },
      _count: { _all: true },
    }),
  ]);
  const result = new Map<string, { crew: number; free: number }>();
  for (const member of crew) {
    for (const skill of member.skills) {
      const row = result.get(skill) ?? { crew: 0, free: 0 };
      row.crew += 1;
      result.set(skill, row);
    }
  }
  for (const [skill, row] of result) {
    const taken = gigs.find((g) => g.skill === skill)?._count._all ?? 0;
    row.free = Math.max(0, row.crew - taken);
  }
  return result;
}

// The same count, inside a transaction, made safe against a race: the
// active crew rows with the skill are locked (FOR UPDATE, waiting, not
// skipping) before the gigs are counted, so two bookings racing for the
// last free person of a skill on a date take turns, and the second sees
// the first's gig. Unlike units, a gig isn't tied to a specific person at
// booking time, so a count under a lock is the right shape here.
export async function lockCrewCapacity(tx: Tx, accountId: string, skill: string, date: string, excludeGigId?: string): Promise<number> {
  const crew = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM crew_members
    WHERE account_id = ${accountId} AND active = true AND ${skill} = ANY(skills)
    ORDER BY id
    FOR UPDATE`;
  if (crew.length === 0) return 0;
  const taken = await tx.gig.count({
    where: {
      accountId,
      skill,
      eventDate: new Date(`${date}T00:00:00Z`),
      status: { not: "Cancelled" },
      ...(excludeGigId ? { id: { not: excludeGigId } } : {}),
    },
  });
  return crew.length - taken;
}

// Creates one gig for a service item on a booking, after checking there is
// a free person for it under the lock. Throws NoCrewFree otherwise.
export async function createGig(
  tx: Tx,
  input: { accountId: string; bookingId: string; item: { id: string; name: string; requiredSkill: string }; date: Date },
) {
  const dateText = input.date.toISOString().slice(0, 10);
  const free = await lockCrewCapacity(tx, input.accountId, input.item.requiredSkill, dateText);
  if (free <= 0) throw new NoCrewFree(input.item.name);
  return tx.gig.create({
    data: {
      accountId: input.accountId,
      bookingId: input.bookingId,
      itemId: input.item.id,
      itemName: input.item.name,
      skill: input.item.requiredSkill,
      eventDate: input.date,
    },
  });
}

// A cancelled booking's gigs are cancelled with it, never left dangling.
export function cancelGigs(tx: Tx, bookingId: string) {
  return tx.gig.updateMany({ where: { bookingId, status: { not: "Cancelled" } }, data: { status: "Cancelled" } });
}

// A rescheduled booking's gigs move with it. Each one is checked for a free
// person on the new date (itself excluded from the count) under the same
// lock, so a move onto a day the crew can't cover is refused whole, like
// a move onto a day with no free unit.
export async function moveGigs(tx: Tx, accountId: string, bookingId: string, newDate: Date) {
  const gigs = await tx.gig.findMany({ where: { bookingId, status: { not: "Cancelled" } } });
  const dateText = newDate.toISOString().slice(0, 10);
  for (const gig of gigs) {
    const free = await lockCrewCapacity(tx, accountId, gig.skill, dateText, gig.id);
    if (free <= 0) throw new NoCrewFree(gig.itemName);
  }
  if (gigs.length > 0) {
    await tx.gig.updateMany({ where: { id: { in: gigs.map((g) => g.id) } }, data: { eventDate: newDate } });
  }
}

// The slim gig view carried on every admin booking.
export const BOOKING_GIGS_SELECT = {
  select: {
    id: true,
    itemId: true,
    itemName: true,
    skill: true,
    status: true,
    filledBy: { select: { id: true, name: true } },
  },
  orderBy: { createdAt: "asc" as const },
};
