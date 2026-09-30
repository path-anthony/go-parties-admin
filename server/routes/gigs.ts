import { AGREEMENT_SELECT } from "../agreements.js";
import { BidError, acceptOffer, extendDeadline, inviteBids, notifyAccepted, offerState, prefillFromBooking, rangeFlag } from "../bids.js";
import { buildMessageValues } from "../messageContext.js";
import { renderChannel } from "../sendTemplated.js";
import { getEffectiveTemplates } from "../templates.js";
import { mustGetTrigger } from "../triggers.js";
import type { Response } from "express";
import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { GIG_STATUSES } from "../skills.js";
import { isOneOf } from "../validate.js";

const router = Router();

// Everything a gig row or the gig popup shows: the booking it came from,
// who filled it, and every offer with the person it went to.
const GIG_DETAIL = {
  booking: { select: { id: true, customerName: true, eventDate: true, eventTime: true, address: true, occasion: true, status: true, leadId: true, rush: true, retainerPaid: true, balancePaymentPreference: true, agreement: AGREEMENT_SELECT } },
  filledBy: { select: { id: true, name: true } },
  offers: {
    include: { crewMember: { select: { id: true, name: true, phone: true, email: true, active: true, smsConsent: true } }, questions: { orderBy: { createdAt: "asc" as const } } },
    orderBy: { createdAt: "asc" as const },
  },
};

// Bidding facts computed once, on the server: the state the crew page would
// show, and whether a bid sits outside the pay range.
function decorate<G extends { status: string; payMin: number | null; payMax: number | null; offers: { status: string; bidAmount: number | null; deadlineAt: Date | null }[] }>(gig: G, now = new Date()) {
  return {
    ...gig,
    offers: gig.offers.map((o) => ({
      ...o,
      bidState: offerState(o, gig.status, now),
      rangeFlag: o.bidAmount === null ? null : rangeFlag(o.bidAmount, gig.payMin, gig.payMax),
    })),
  };
}

async function findGig(id: string) {
  const account = await getDefaultAccount();
  return prisma.gig.findFirst({ where: { id, accountId: account.id }, include: GIG_DETAIL });
}

function fail(res: Response, err: unknown) {
  if (err instanceof BidError) return res.status(err.status).json(err.reason ? { error: err.message, reason: err.reason } : { error: err.message });
  throw err;
}

// The gig plus the people who could take it: every active crew member
// with the skill, whether or not they already have an offer on it.
async function gigWithCandidates(id: string) {
  const gig = await findGig(id);
  if (!gig) return null;
  const candidates = await prisma.crewMember.findMany({
    where: { accountId: gig.accountId, active: true, skills: { has: gig.skill } },
    select: { id: true, name: true, phone: true, email: true, smsConsent: true },
    orderBy: { name: "asc" },
  });
  return { ...decorate(gig), candidates, prefill: prefillFromBooking(gig.booking) };
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
  res.json(gigs.map((g) => decorate(g)));
});

// Gigs with bidding open or waiting on a pick, for Crew & Gigs > Bids.
router.get("/bids/summary", async (_req, res) => {
  const account = await getDefaultAccount();
  const now = new Date();
  const gigs = await prisma.gig.findMany({
    where: { accountId: account.id, status: "Offered", offers: { some: { token: { not: null } } } },
    include: { offers: true, booking: { select: { eventDate: true } } },
    orderBy: [{ eventDate: "asc" }],
  });
  res.json(
    gigs.map((g) => {
      const invited = g.offers.filter((o) => o.token);
      const live = invited.filter((o) => o.status === "Sent");
      const bids = live.filter((o) => o.bidAmount !== null);
      const deadlines = live.map((o) => o.deadlineAt).filter((d): d is Date => d !== null);
      const deadlineAt = deadlines.length ? new Date(Math.max(...deadlines.map((d) => d.getTime()))) : null;
      return {
        id: g.id,
        role: g.skill,
        itemName: g.itemName,
        eventDate: g.eventDate.toISOString().slice(0, 10),
        town: g.town,
        invited: invited.length,
        bidsIn: bids.length,
        declines: invited.filter((o) => o.status === "Declined").length,
        deadlineAt,
        lowestBid: bids.length ? Math.min(...bids.map((o) => o.bidAmount as number)) : null,
        readyToPick: deadlineAt !== null && deadlineAt.getTime() < now.getTime() && bids.length > 0,
      };
    }),
  );
});

router.get("/:id", async (req, res) => {
  const gig = await gigWithCandidates(String(req.params.id));
  if (!gig) return res.status(404).json({ error: "gig not found" });
  res.json(gig);
});

// Edits what the crew page shows about a gig.
router.patch("/:id", async (req, res) => {
  const gig = await findGig(String(req.params.id));
  if (!gig) return res.status(404).json({ error: "gig not found" });
  const b = (req.body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  const text = (k: string, max: number) => {
    if (!(k in b)) return null;
    const v = b[k];
    if (v === null || (typeof v === "string" && v.trim() === "")) return (data[k] = null), null;
    if (typeof v !== "string" || v.length > max) return `${k} must be text up to ${max} characters`;
    data[k] = v.trim();
    return null;
  };
  const num = (k: string) => {
    if (!(k in b)) return null;
    const v = b[k];
    if (v === null) return (data[k] = null), null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100000) return `${k} must be a whole number`;
    data[k] = v;
    return null;
  };
  const problem = [text("eventType", 80), text("startTime", 40), text("endTime", 40), text("town", 80), text("arrivalNotes", 1000), num("guestCount"), num("payMin"), num("payMax")].find(Boolean);
  if (problem) return res.status(400).json({ error: problem });
  const min = (data.payMin ?? gig.payMin) as number | null;
  const max = (data.payMax ?? gig.payMax) as number | null;
  if (min !== null && max !== null && min > max) return res.status(400).json({ error: "The minimum pay can't be above the maximum." });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: "no editable fields provided" });
  await prisma.gig.update({ where: { id: gig.id }, data });
  res.json(await gigWithCandidates(gig.id));
});

function readInvite(body: Record<string, unknown>) {
  const ids = body.crewMemberIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id): id is string => typeof id === "string" && id !== "")) throw new BidError(400, null, "crewMemberIds must be a non-empty list of crew member ids");
  let deadlineAt: Date;
  if (typeof body.deadlineAt === "string" && !Number.isNaN(Date.parse(body.deadlineAt))) deadlineAt = new Date(body.deadlineAt);
  else deadlineAt = new Date(Date.now() + (typeof body.deadlineHours === "number" ? body.deadlineHours : 48) * 3_600_000);
  if (typeof body.payMin !== "number" || typeof body.payMax !== "number") throw new BidError(400, null, "Set a pay range: both a minimum and a maximum.");
  const f = (body.fields ?? {}) as Record<string, unknown>;
  const fields: NonNullable<Parameters<typeof inviteBids>[1]["fields"]> = {};
  for (const k of ["eventType", "startTime", "endTime", "town", "arrivalNotes"] as const) if (typeof f[k] === "string") fields[k] = (f[k] as string).trim() || null;
  if (typeof f.guestCount === "number") fields.guestCount = f.guestCount;
  return { crewMemberIds: [...new Set(ids)], payMin: body.payMin, payMax: body.payMax, deadlineAt, fields };
}

// Invites crew to bid: sets the pay range and deadline, makes one offer with
// its own link per person, and texts each the invite. Anyone who already has
// an offer is skipped. A gig that needed crew becomes Offered.
router.post("/:id/offers", async (req, res) => {
  const gig = await findGig(String(req.params.id));
  if (!gig) return res.status(404).json({ error: "gig not found" });
  try {
    const result = await inviteBids(gig.id, readInvite((req.body ?? {}) as Record<string, unknown>));
    if (result.offered > 0) await logActivity(gig.booking.leadId, `${gig.itemName}: invited ${result.offered} crew to bid.`);
    res.json({ ...(await gigWithCandidates(gig.id)), offered: result.offered, skipped: result.skipped, messages: result.messages });
  } catch (err) {
    fail(res, err);
  }
});

// What the invite text will say, filled in from the gig as it would be sent.
router.post("/:id/invite-preview", async (req, res) => {
  const gig = await findGig(String(req.params.id));
  if (!gig) return res.status(404).json({ error: "gig not found" });
  try {
    const i = readInvite({ crewMemberIds: ["x"], ...(req.body ?? {}) });
    const def = mustGetTrigger("gig_bid_invite");
    const tpl = (await getEffectiveTemplates(gig.accountId, "gig_bid_invite")).sms;
    const pre = prefillFromBooking(gig.booking);
    const values = await buildMessageValues(gig.accountId, { gigId: gig.id });
    const town = i.fields.town ?? gig.town ?? pre.town ?? "";
    const storefront = process.env.STOREFRONT_URL?.replace(/\/$/, "");
    const merged = {
      ...values,
      gig_town: town,
      bid_range: `$${i.payMin} to $${i.payMax}`,
      bid_deadline: (await import("../automation/time.js")).humanWhen(i.deadlineAt),
      ...(storefront ? { bid_link: `${storefront}/bid/(their own link)` } : {}),
      crew_first_name: "Jordan",
    };
    const r = renderChannel(def, tpl, "sms", merged);
    res.json({ text: r.body.text, problem: r.why });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/:id/extend-deadline", async (req, res) => {
  const gig = await findGig(String(req.params.id));
  if (!gig) return res.status(404).json({ error: "gig not found" });
  const at = (req.body ?? {}).deadlineAt;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return res.status(400).json({ error: "deadlineAt must be a date and time" });
  try {
    await extendDeadline(gig.id, new Date(at));
    res.json(await gigWithCandidates(gig.id));
  } catch (err) {
    fail(res, err);
  }
});

// Marks one offer Accepted or Declined, by hand. Accepting goes through the
// same function the bid screen uses: the winner is Accepted, everyone still
// in the running is Not Selected, the gig is Filled, and the texts go out
// after. A second accept on a gig already filled is refused with the name.
// Declining the accepted offer reopens the gig.
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
    try {
      const result = await acceptOffer(gig.id, offer.id);
      await logActivity(gig.booking.leadId, `${gig.itemName}: ${offer.crewMember.name} accepted, gig filled.`);
      await notifyAccepted(result);
    } catch (err) {
      return fail(res, err);
    }
  } else {
    const wasTheFill = gig.filledById === offer.crewMemberId && offer.status === "Accepted";
    const othersOpen = gig.offers.some((o) => o.id !== offer.id && o.status === "Sent");
    await prisma.$transaction([
      prisma.gigOffer.update({ where: { id: offer.id }, data: { status: "Declined", declinedAt: new Date() } }),
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
