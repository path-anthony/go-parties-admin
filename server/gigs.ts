import { Prisma } from "../src/generated/prisma/client.js";
import { prisma } from "./db.js";

type Tx = Prisma.TransactionClient;

// An item with skills needs people to run it, whether or not it is also a
// physical piece with units. Booking it creates one gig per skill per
// unit wanted, on top of any unit it holds.
export function needsCrew(item: { skills: string[] }): boolean {
  return item.skills.length > 0;
}

// Thrown inside a transaction when no crew member with the skill is free
// on the date, so the transaction rolls back with nothing written. Caught
// alongside NoFreeUnit wherever bookings are made or moved.
export class NoCrewFree extends Error {
  readonly itemName: string;
  readonly skill: string;

  constructor(itemName: string, skill: string) {
    super(`No ${skill} free for ${itemName}`);
    this.itemName = itemName;
    this.skill = skill;
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

// How many of an item can be booked on a date, read only. An item with
// units is bounded by its free units; an item with skills is bounded by
// the free crew of every one of its skills; an item with both is bounded
// by whichever is tighter. An item with neither can't be promised at all.
export function freeForItem(
  item: { skills: string[] },
  unitCount: number,
  unitsFree: number,
  crew: Map<string, { crew: number; free: number }>,
): number {
  if (unitCount === 0 && item.skills.length === 0) return 0;
  let free = unitCount > 0 ? unitsFree : Number.POSITIVE_INFINITY;
  for (const skill of item.skills) free = Math.min(free, crew.get(skill)?.free ?? 0);
  return Number.isFinite(free) ? free : 0;
}

// The same count, inside a transaction, made safe against a race: the
// active crew rows with the skill are locked (FOR UPDATE, waiting, not
// skipping) before the gigs are counted, so two bookings racing for the
// last free person of a skill on a date take turns, and the second sees
// the first's gig. Unlike units, a gig isn't tied to a specific person at
// booking time, so a count under a lock is the right shape here.
//
// Lock order matters once an item can need several skills: every caller
// locks units first (SKIP LOCKED, never waits) and then skills in
// alphabetical order (see createGigs), so two transactions that need the
// same two skills always take them in the same order and can't deadlock.
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

type GigNeed = { item: { id: string; name: string }; skill: string };

// Creates the gigs a set of items needs, one per skill per unit wanted,
// each checked for a free person under the crew lock. Needs are taken in
// alphabetical skill order across every item so the lock order is the
// same in every transaction. Throws NoCrewFree naming the item and skill
// that couldn't be covered; the caller's transaction then rolls back.
export async function createGigs(
  tx: Tx,
  input: { accountId: string; bookingId: string; date: Date; wanted: { item: { id: string; name: string; skills: string[] }; quantity: number }[] },
) {
  const needs: GigNeed[] = [];
  for (const { item, quantity } of input.wanted) {
    for (const skill of item.skills) for (let n = 0; n < quantity; n++) needs.push({ item, skill });
  }
  needs.sort((a, b) => a.skill.localeCompare(b.skill) || a.item.name.localeCompare(b.item.name));
  const dateText = input.date.toISOString().slice(0, 10);
  const created: { id: string; itemId: string; itemName: string; skill: string }[] = [];
  for (const need of needs) {
    const free = await lockCrewCapacity(tx, input.accountId, need.skill, dateText);
    if (free <= 0) throw new NoCrewFree(need.item.name, need.skill);
    const gig = await tx.gig.create({
      data: {
        accountId: input.accountId,
        bookingId: input.bookingId,
        itemId: need.item.id,
        itemName: need.item.name,
        skill: need.skill,
        eventDate: input.date,
      },
    });
    created.push({ id: gig.id, itemId: need.item.id, itemName: need.item.name, skill: need.skill });
  }
  return created;
}

// A cancelled booking's gigs are cancelled with it, every skill of every
// item, never left dangling.
export function cancelGigs(tx: Tx, bookingId: string) {
  return tx.gig.updateMany({ where: { bookingId, status: { not: "Cancelled" } }, data: { status: "Cancelled" } });
}

// A rescheduled booking's gigs move with it. Each one is checked for a free
// person on the new date (itself excluded from the count) under the same
// lock, in skill order, so a move onto a day the crew can't cover is
// refused whole, like a move onto a day with no free unit.
export async function moveGigs(tx: Tx, accountId: string, bookingId: string, newDate: Date) {
  const gigs = await tx.gig.findMany({ where: { bookingId, status: { not: "Cancelled" } }, orderBy: [{ skill: "asc" }, { createdAt: "asc" }] });
  const dateText = newDate.toISOString().slice(0, 10);
  for (const gig of gigs) {
    const free = await lockCrewCapacity(tx, accountId, gig.skill, dateText, gig.id);
    if (free <= 0) throw new NoCrewFree(gig.itemName, gig.skill);
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
