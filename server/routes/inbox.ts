import { Router, type Response } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { bookingMapsUrl } from "../delivery.js";
import { CONTACT_KINDS, INBOX_TABS, LOST_REASONS, contactParts, matchLead, sourceWords, type ContactKind } from "../inbox.js";
import { LeadActionError, cleanNote, loadInbox, loadToday, logContact, markLost, reopenLead, sendStoreLink, setFollowUp } from "../inboxLoad.js";
import { INVALID, normalizeDate, todayEastern } from "../validate.js";

// Block F3a. The Leads inbox, the Today view, and the three things staff do
// to a lead (contact, how they buy, close). Everything here is staff only:
// the routers are mounted behind the admin session in server/index.ts.

function fail(res: Response, err: unknown) {
  if (err instanceof LeadActionError) return res.status(err.status).json({ error: err.message, reason: err.reason });
  throw err;
}

// ---- GET /api/inbox, GET /api/today ------------------------------------------------

export const inboxRouter = Router();

inboxRouter.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const inbox = await loadInbox(account.id);
  res.json({ tabs: INBOX_TABS.map((t) => ({ ...t, count: inbox.counts[t.key] })), rows: inbox.rows, lostReasons: LOST_REASONS, contactKinds: CONTACT_KINDS, columns: inbox.columns });
});

export const todayRouter = Router();

todayRouter.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  res.json(await loadToday(account.id));
});

// ---- on one lead: /api/leads/:id/... ------------------------------------------------

export const leadActionsRouter = Router();

const BOOKING_DETAIL = {
  id: true,
  status: true,
  retainerPaid: true,
  confirmedAt: true,
  eventDate: true,
  eventTime: true,
  occasion: true,
  guestCount: true,
  address: true,
  setupNotes: true,
  total: true,
  tier: true,
  placeId: true,
  addressLat: true,
  addressLng: true,
  setupLat: true,
  setupLng: true,
  package: { select: { name: true } },
  units: { select: { unit: { select: { item: { select: { name: true } } } } } },
  gigs: { select: { itemName: true } },
  addons: { select: { itemName: true, groupName: true, addonName: true }, orderBy: { createdAt: "asc" as const } },
} as const;

// Everything the lead popup shows in "Who" and "What they want", in one call.
leadActionsRouter.get("/:id/detail", async (req, res) => {
  const account = await getDefaultAccount();
  const lead = await prisma.lead.findFirst({ where: { id: String(req.params.id), accountId: account.id }, include: { bookings: { select: BOOKING_DETAIL, orderBy: { createdAt: "asc" } } } });
  if (!lead) return res.status(404).json({ error: "lead not found" });
  const parts = contactParts(lead.contact);
  // Other leads that look like the same person, for a human to judge.
  const others = await prisma.lead.findMany({ where: { accountId: account.id, id: { not: lead.id } }, select: { id: true, status: true, customerName: true, contact: true, createdAt: true, source: true, bookings: { select: { status: true } } }, take: 5000 });
  const match = matchLead(others, { name: lead.customerName, email: parts.email, phone: parts.phone }, new Date());
  const possible = [...(match.exact ? [match.exact] : []), ...match.near].map((m) => ({ id: m.id, name: m.customerName ?? "No name yet", source: sourceWords((m as { source?: string }).source ?? ""), stage: m.status, createdAt: m.createdAt.toISOString() }));
  res.json({
    id: lead.id,
    source: sourceWords(lead.source),
    sourceKey: lead.source,
    stage: lead.status,
    name: lead.customerName,
    contact: lead.contact,
    phone: parts.phone,
    email: parts.email,
    createdAt: lead.createdAt.toISOString(),
    occasion: lead.occasion,
    dateOfInterest: lead.dateOfInterest?.toISOString().slice(0, 10) ?? null,
    notes: lead.notes,
    theme: lead.theme,
    itemsReturned: lead.itemsReturned,
    tags: lead.tags,
    firstContactedAt: lead.firstContactedAt?.toISOString() ?? null,
    lastContactedAt: lead.lastContactedAt?.toISOString() ?? null,
    followUpOn: lead.followUpOn?.toISOString().slice(0, 10) ?? null,
    followUpNote: lead.followUpNote,
    lostReason: lead.lostReason,
    lostNote: lead.lostNote,
    lostAt: lead.lostAt?.toISOString() ?? null,
    storeLinkSentAt: lead.storeLinkSentAt?.toISOString() ?? null,
    automationPaused: lead.automationPaused,
    possibleMatches: possible,
    bookings: lead.bookings.map((b) => ({
      id: b.id,
      status: b.status,
      retainerPaid: b.retainerPaid,
      confirmedAt: b.confirmedAt?.toISOString() ?? null,
      eventDate: b.eventDate.toISOString().slice(0, 10),
      eventTime: b.eventTime,
      occasion: b.occasion,
      guestCount: b.guestCount,
      address: b.address,
      mapsUrl: bookingMapsUrl(b),
      setupNotes: b.setupNotes,
      total: b.total === null ? null : Number(b.total),
      tier: b.tier,
      packageName: b.package?.name ?? null,
      items: [...b.units.map((u) => u.unit.item.name), ...b.gigs.map((g) => g.itemName)],
      addons: b.addons,
    })),
  });
});

// Contact: a call, a text or an email staff made, with a note.
leadActionsRouter.post("/:id/contact", async (req, res) => {
  const account = await getDefaultAccount();
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!(CONTACT_KINDS as readonly unknown[]).includes(body.kind)) return res.status(400).json({ error: `kind must be one of ${CONTACT_KINDS.join(", ")}`, reason: "kind-invalid" });
  try {
    res.status(201).json(await logContact(account.id, String(req.params.id), body.kind as ContactKind, cleanNote(body.note)));
  } catch (err) {
    fail(res, err);
  }
});

// How they buy: send the store link by text and email.
leadActionsRouter.post("/:id/store-link", async (req, res) => {
  const account = await getDefaultAccount();
  try {
    res.json(await sendStoreLink(account.id, String(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

// Not ready: a date to come back and a note. { date: null } clears it.
leadActionsRouter.post("/:id/follow-up", async (req, res) => {
  const account = await getDefaultAccount();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const date = normalizeDate(body.date);
  if (date === INVALID) return res.status(400).json({ error: "Pick the day to follow up.", reason: "date-invalid", field: "date" });
  if (date !== null && date.toISOString().slice(0, 10) < todayEastern()) return res.status(400).json({ error: "The follow up day cannot be in the past.", reason: "date-past", field: "date" });
  try {
    await setFollowUp(account.id, String(req.params.id), date, cleanNote(body.note, 500));
    res.json({ followUpOn: date ? date.toISOString().slice(0, 10) : null });
  } catch (err) {
    fail(res, err);
  }
});

// Close: Lost, with a reason from the list.
leadActionsRouter.post("/:id/lost", async (req, res) => {
  const account = await getDefaultAccount();
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.reason !== "string" || body.reason.trim() === "") return res.status(400).json({ error: `Pick a reason: ${LOST_REASONS.join(", ")}.`, reason: "reason-required", field: "reason" });
  try {
    res.json(await markLost(account.id, String(req.params.id), body.reason, cleanNote(body.note, 500)));
  } catch (err) {
    fail(res, err);
  }
});

leadActionsRouter.post("/:id/reopen", async (req, res) => {
  const account = await getDefaultAccount();
  try {
    res.json(await reopenLead(account.id, String(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});
