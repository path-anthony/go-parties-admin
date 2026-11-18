import { Router } from "express";
import { notifyNewLead } from "../notifications.js";
import { getDefaultAccount } from "../account.js";
import { botCheck } from "../botCheck.js";
import { prisma } from "../db.js";
import { contactLine, leadContactFrom } from "../leadContact.js";
import { getDefaultStatus } from "../leadStatuses.js";
import { safeInline } from "../sanitize.js";
import { settleOccasion } from "../occasionText.js";
import { INVALID, isOneOf, normalizeDate, normalizeText } from "../validate.js";

// Where the customer chose to talk to a person instead of checking out.
const ENTRY_POINTS = ["checkout", "ask_go"] as const;
const ENTRY_LABEL: Record<(typeof ENTRY_POINTS)[number], string> = { checkout: "the checkout", ask_go: "Ask GO" };
const MAX_TEXT = 200;
const CALENDLY_URL = "https://calendly.com/goevent/30min";

const router = Router();

function shortText(value: unknown): string | null | typeof INVALID {
  const raw = normalizeText(value);
  if (raw === null) return null;
  if (raw.length > MAX_TEXT) return INVALID;
  // Lands in a note staff read and in a Calendly prefill: no links, no
  // control characters.
  return safeInline(raw, MAX_TEXT) || null;
}

// Public, no session, rate limited where it's mounted. The storefront
// calls this right before sending the customer to Calendly, so Andy and
// Mel have the context (occasion, what they were looking at, the date) in
// the CRM when Calendly's own notification arrives. No name or contact
// is taken here; Calendly collects that. The lead is source "concierge",
// tagged "concierge" and with where it came from, so it reads as its own
// kind of lead on the board. Nothing here waits on anything slow. Since
// Block F2 a request with no name, email or phone makes no lead at all.
router.post("/", botCheck("concierge"), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!isOneOf(ENTRY_POINTS, body.source)) {
    return res.status(400).json({ error: `source is required and must be one of ${ENTRY_POINTS.join(", ")}` });
  }
  const occasion = shortText(body.occasion);
  const context = shortText(body.itemOrPackage ?? body.context);
  if (occasion === INVALID || context === INVALID) {
    return res.status(400).json({ error: `occasion and itemOrPackage must be text up to ${MAX_TEXT} characters` });
  }
  const date = normalizeDate(body.eventDate);
  if (date === INVALID) {
    return res.status(400).json({ error: "eventDate must be YYYY-MM-DD" });
  }

  const account = await getDefaultAccount();
  const from = ENTRY_LABEL[body.source];
  // Block F2: a lead is made only when there is somebody to reach (a name,
  // an email or a phone, sent with the request or from a signed-in account).
  // With none of the three the customer still goes to Calendly, which takes
  // their details, and nothing is added to Leads.
  const who = await leadContactFrom(req, body);
  if (!who) return res.json({ ok: true, leadId: null });
  // Block FIX1: the occasion comes from what the customer wrote. The store
  // may send the Ask GO chat (messages, the customer's lines only are read);
  // otherwise the Ask GO lead this customer made in the last six hours is
  // read. The store's own occasion is kept beside it, and loses when they
  // disagree.
  const said = await customerWords(account.id, body, who);
  const settled = settleOccasion(occasion, said);
  const lines = [
    `Asked to talk to a person from ${from} and was sent to Calendly (${CALENDLY_URL}).`,
    context ? `Was looking at: ${context}.` : null,
  ].filter((line): line is string => line !== null);

  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      source: "concierge",
      status: await getDefaultStatus(account.id),
      tags: ["concierge", body.source === "checkout" ? "from checkout" : "from Ask GO"],
      customerName: who.name,
      contact: contactLine(who),
      occasion: settled.occasion,
      occasionFromStore: settled.fromStore,
      occasionFromChat: settled.fromChat,
      theme: context,
      dateOfInterest: date,
      notes: lines.join(" "),
    },
  });
  await prisma.leadActivity.create({
    data: { leadId: lead.id, text: `Concierge request from ${from}${context ? `, about ${context}` : ""}. Sent to Calendly.` },
  });
  if (settled.conflict) {
    await prisma.leadActivity.create({ data: { leadId: lead.id, kind: "status", text: `Occasion mismatch: the store sent "${settled.fromStore}", but the customer wrote about "${settled.fromChat}". The lead uses "${settled.fromChat}".` } });
  }

  await notifyNewLead(lead);
  res.status(201).json({ ok: true, leadId: lead.id });
});

// The customer's own words from Ask GO, for the occasion: the messages the
// store sent, else the newest Ask GO lead for the same email or phone made
// in the last six hours. Empty when there is neither.
async function customerWords(accountId: string, body: Record<string, unknown>, who: { email: string | null; phone: string | null }): Promise<string> {
  if (Array.isArray(body.messages)) {
    return body.messages
      .slice(-20)
      .filter((m): m is { role: string; content: string } => !!m && typeof m === "object" && (m as { role?: unknown }).role === "user" && typeof (m as { content?: unknown }).content === "string")
      .map((m) => m.content.slice(0, 500))
      .join(" / ");
  }
  if (body.source !== "ask_go") return "";
  const ors = [who.email ? { contact: { contains: who.email, mode: "insensitive" as const } } : null, who.phone ? { contact: { contains: who.phone } } : null].filter((x): x is NonNullable<typeof x> => x !== null);
  if (ors.length === 0) return "";
  const recent = await prisma.lead.findFirst({ where: { accountId, source: "ask-go", createdAt: { gte: new Date(Date.now() - 6 * 3_600_000) }, OR: ors }, orderBy: { createdAt: "desc" }, select: { theme: true } });
  return recent?.theme ?? "";
}

export default router;
