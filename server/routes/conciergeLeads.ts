import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { getDefaultStatus } from "../leadStatuses.js";
import { INVALID, isOneOf, normalizeDate, normalizeText } from "../validate.js";

// Where the customer chose to talk to a person instead of checking out.
const ENTRY_POINTS = ["checkout", "ask_go"] as const;
const ENTRY_LABEL: Record<(typeof ENTRY_POINTS)[number], string> = { checkout: "the checkout", ask_go: "Ask GO" };
const MAX_TEXT = 200;
const CALENDLY_URL = "https://calendly.com/goevent/30min";

const router = Router();

function shortText(value: unknown): string | null | typeof INVALID {
  const text = normalizeText(value);
  if (text === null) return null;
  return text.length <= MAX_TEXT ? text : INVALID;
}

// Public, no session, rate limited where it's mounted. The storefront
// calls this right before sending the customer to Calendly, so Andy and
// Mel have the context (occasion, what they were looking at, the date) in
// the CRM when Calendly's own notification arrives. No name or contact
// is taken here; Calendly collects that. The lead is source "concierge",
// tagged "concierge" and with where it came from, so it reads as its own
// kind of lead on the board. Nothing here waits on anything slow.
router.post("/", async (req, res) => {
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
  const lines = [
    `Asked to talk to a person from ${from} and was sent to Calendly (${CALENDLY_URL}).`,
    context ? `Was looking at: ${context}.` : null,
    "Name and contact come with the Calendly booking.",
  ].filter((line): line is string => line !== null);

  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      source: "concierge",
      status: await getDefaultStatus(account.id),
      tags: ["concierge", body.source === "checkout" ? "from checkout" : "from Ask GO"],
      occasion,
      theme: context,
      dateOfInterest: date,
      notes: lines.join(" "),
    },
  });
  await prisma.leadActivity.create({
    data: { leadId: lead.id, text: `Concierge request from ${from}${context ? `, about ${context}` : ""}. Sent to Calendly.` },
  });

  res.status(201).json({ ok: true, leadId: lead.id });
});

export default router;
