import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { GIG_STATUSES } from "../skills.js";
import { isOneOf } from "../validate.js";

const router = Router();

// Everything a gig row or the gig popup shows: the booking it came from,
// who filled it, and every offer with the person it went to.
const GIG_DETAIL = {
  booking: { select: { id: true, customerName: true, eventDate: true, eventTime: true, status: true, leadId: true } },
  filledBy: { select: { id: true, name: true } },
  offers: {
    include: { crewMember: { select: { id: true, name: true, phone: true, email: true, active: true } } },
    orderBy: { createdAt: "asc" as const },
  },
};

async function findGig(id: string) {
  const account = await getDefaultAccount();
  return prisma.gig.findFirst({ where: { id, accountId: account.id }, include: GIG_DETAIL });
}

// The gig plus the people who could take it: every active crew member
// with the skill, whether or not they already have an offer on it.
async function gigWithCandidates(id: string) {
  const gig = await findGig(id);
  if (!gig) return null;
  const candidates = await prisma.crewMember.findMany({
    where: { accountId: gig.accountId, active: true, skills: { has: gig.skill } },
    select: { id: true, name: true, phone: true, email: true },
    orderBy: { name: "asc" },
  });
  return { ...gig, candidates };
}

async function logActivity(leadId: string | null, text: string) {
  if (leadId) await prisma.leadActivity.create({ data: { leadId, text } });
}

router.get("/", async (req, res) => {
  const account = await getDefaultAccount();
  const status = typeof req.query.status === "string" ? req.query.status : "";
  if (status !== "" && !isOneOf(GIG_STATUSES, status)) {
    return res.status(400).json({ error: `status must be one of ${GIG_STATUSES.join(", ")}` });
  }
  const gigs = await prisma.gig.findMany({
    where: { accountId: account.id, ...(status ? { status } : {}) },
    include: GIG_DETAIL,
    orderBy: [{ eventDate: "asc" }, { createdAt: "asc" }],
  });
  res.json(gigs);
});

router.get("/:id", async (req, res) => {
  const gig = await gigWithCandidates(String(req.params.id));
  if (!gig) return res.status(404).json({ error: "gig not found" });
  res.json(gig);
});

// Records an offer (status Sent) to each crew member named. Nothing is
// sent anywhere yet; this is the admin's record of who was asked. Each
// person has to be active and have the skill; anyone who already has an
// offer on this gig is skipped rather than refused. A gig that needed
// crew becomes Offered.
router.post("/:id/offers", async (req, res) => {
  const gig = await findGig(String(req.params.id));
  if (!gig) return res.status(404).json({ error: "gig not found" });
  if (gig.status === "Cancelled") return res.status(400).json({ error: "This gig was cancelled with its booking." });
  const ids = (req.body ?? {}).crewMemberIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id): id is string => typeof id === "string" && id !== "")) {
    return res.status(400).json({ error: "crewMemberIds must be a non-empty list of crew member ids" });
  }
  const unique = [...new Set(ids)];
  const eligible = await prisma.crewMember.findMany({
    where: { id: { in: unique }, accountId: gig.accountId, active: true, skills: { has: gig.skill } },
    select: { id: true, name: true },
  });
  if (eligible.length !== unique.length) {
    return res.status(400).json({ error: `Every person offered this gig has to be active and have the ${gig.skill} skill.` });
  }
  const already = new Set(gig.offers.map((o) => o.crewMemberId));
  const fresh = eligible.filter((m) => !already.has(m.id));
  await prisma.$transaction(async (tx) => {
    if (fresh.length > 0) {
      await tx.gigOffer.createMany({ data: fresh.map((m) => ({ gigId: gig.id, crewMemberId: m.id })) });
    }
    if (gig.status === "Needs Crew" && (fresh.length > 0 || already.size > 0)) {
      await tx.gig.update({ where: { id: gig.id }, data: { status: "Offered" } });
    }
  });
  if (fresh.length > 0) {
    await logActivity(gig.booking.leadId, `${gig.itemName}: offered to ${fresh.map((m) => m.name).join(", ")} from the admin.`);
  }
  res.json({ ...(await gigWithCandidates(gig.id)), offered: fresh.length, skipped: unique.length - fresh.length });
});

// Marks one offer Accepted or Declined, by hand. Accepting fills the gig
// and records who; a second Accepted on a gig already filled by someone
// else is refused with the name. Declining the accepted offer reopens the
// gig: Offered if anyone else still has an open offer, else Needs Crew.
router.patch("/:id/offers/:offerId", async (req, res) => {
  const gig = await findGig(String(req.params.id));
  const offer = gig?.offers.find((o) => o.id === String(req.params.offerId));
  if (!gig || !offer) return res.status(404).json({ error: "offer not found" });
  if (gig.status === "Cancelled") return res.status(400).json({ error: "This gig was cancelled with its booking." });
  const status = (req.body ?? {}).status;
  if (status !== "Accepted" && status !== "Declined") {
    return res.status(400).json({ error: "status must be Accepted or Declined" });
  }

  if (status === "Accepted") {
    if (gig.status === "Filled" && gig.filledById !== offer.crewMemberId) {
      const holder = gig.filledBy?.name ?? "someone else";
      return res.status(409).json({
        error: `${gig.itemName} is already filled by ${holder}. Decline their offer first if ${offer.crewMember.name} should take it instead.`,
        reason: "already-filled",
      });
    }
    await prisma.$transaction([
      prisma.gigOffer.update({ where: { id: offer.id }, data: { status: "Accepted" } }),
      prisma.gig.update({ where: { id: gig.id }, data: { status: "Filled", filledById: offer.crewMemberId } }),
    ]);
    await logActivity(gig.booking.leadId, `${gig.itemName}: ${offer.crewMember.name} accepted, gig filled.`);
  } else {
    const wasTheFill = gig.filledById === offer.crewMemberId && offer.status === "Accepted";
    const othersOpen = gig.offers.some((o) => o.id !== offer.id && o.status === "Sent");
    await prisma.$transaction([
      prisma.gigOffer.update({ where: { id: offer.id }, data: { status: "Declined" } }),
      ...(wasTheFill
        ? [prisma.gig.update({ where: { id: gig.id }, data: { status: othersOpen ? "Offered" : "Needs Crew", filledById: null } })]
        : gig.status === "Offered" && !othersOpen
          ? [prisma.gig.update({ where: { id: gig.id }, data: { status: "Needs Crew" } })]
          : []),
    ]);
    await logActivity(
      gig.booking.leadId,
      wasTheFill ? `${gig.itemName}: ${offer.crewMember.name} declined after accepting, gig needs crew again.` : `${gig.itemName}: ${offer.crewMember.name} declined.`,
    );
  }
  res.json(await gigWithCandidates(gig.id));
});

export default router;
