import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { loadPlans } from "../automation/loaders.js";
import { itemName, leadChip, nextLine, type PlanItem } from "../automation/planner.js";
import { runAutomation, upcomingView } from "../automation/runner.js";
import { humanWhen } from "../automation/time.js";
import { prisma } from "../db.js";
import { toE164 } from "../messaging.js";
import { clearOptOut, isOptedOut, markOptedOut } from "../optOuts.js";

// The admin's side of the scheduler: timelines on records, the pause switch,
// the Upcoming page, "Run check now", and opt-out marking. Behind the
// normal admin login (the n8n endpoint is in routes/automations.ts).
const router = Router();

const KINDS = ["lead", "booking", "gig"] as const;
type Kind = (typeof KINDS)[number];
const isKind = (v: unknown): v is Kind => typeof v === "string" && (KINDS as readonly string[]).includes(v);

const wire = (i: PlanItem) => ({
  what: itemName(i),
  triggerKey: i.triggerKey,
  channel: i.channel,
  state: i.state,
  reason: i.reason ?? null,
  dueAt: i.dueAt.toISOString(),
  sendAt: i.sendAt.toISOString(),
  when: humanWhen(i.state === "sent" && i.sentAt ? i.sentAt : i.sendAt),
  attempts: i.attempts,
});

router.get("/timeline", async (req, res) => {
  const { kind, id } = req.query;
  if (!isKind(kind) || typeof id !== "string") return res.status(400).json({ error: "kind and id are required" });
  const plans = await loadPlans({ [kind === "lead" ? "leadId" : kind === "booking" ? "bookingId" : "gigId"]: id });
  const account = await getDefaultAccount();
  const paused =
    kind === "lead"
      ? (await prisma.lead.findFirst({ where: { id, accountId: account.id }, select: { automationPaused: true } }))?.automationPaused
      : kind === "booking"
        ? (await prisma.booking.findFirst({ where: { id, accountId: account.id }, select: { automationPaused: true } }))?.automationPaused
        : (await prisma.gig.findFirst({ where: { id, accountId: account.id }, select: { automationPaused: true } }))?.automationPaused;
  if (paused === undefined) return res.status(404).json({ error: "not found" });

  const entries = await Promise.all(
    plans.map(async (p) => ({
      name: p.name,
      enrolled: p.plan.enrolled,
      notEnrolled: p.plan.notEnrolled ?? null,
      summary: nextLine(p.plan),
      items: p.plan.items.map(wire),
      phone: p.contact.phone,
      optedOut: p.contact.phone ? await isOptedOut(p.contact.phone) : false,
    })),
  );
  res.json({ paused, entries });
});

router.patch("/pause", async (req, res) => {
  const { kind, id, paused } = req.body ?? {};
  if (!isKind(kind) || typeof id !== "string" || typeof paused !== "boolean") return res.status(400).json({ error: "kind, id and paused are required" });
  const account = await getDefaultAccount();
  const data = { automationPaused: paused };
  const where = { id, accountId: account.id };
  const res2 = kind === "lead" ? await prisma.lead.updateMany({ where, data }) : kind === "booking" ? await prisma.booking.updateMany({ where, data }) : await prisma.gig.updateMany({ where, data });
  if (res2.count === 0) return res.status(404).json({ error: "not found" });
  res.json({ paused });
});

// One line per lead for the Leads list.
router.get("/lead-chips", async (_req, res) => {
  const plans = await loadPlans({ kinds: ["lead"], allLeads: true });
  const chips: Record<string, string> = {};
  for (const p of plans) chips[p.recordId] = leadChip(p.plan);
  res.json({ chips });
});

router.get("/upcoming", async (_req, res) => {
  res.json(await upcomingView(14));
});

// "Run check now": dryRun previews, otherwise runs for real. Same code as
// the n8n endpoint.
router.post("/run", async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  res.json(await runAutomation({ dryRun, source: "admin" }));
});

router.get("/last-run", async (_req, res) => {
  const account = await getDefaultAccount();
  const run = await prisma.automationRun.findFirst({ where: { accountId: account.id }, orderBy: { ranAt: "desc" } });
  res.json({ run: run ? { ranAt: run.ranAt.toISOString(), source: run.source, durationMs: run.durationMs, summary: run.summary } : null });
});

function phoneFrom(body: unknown): string | null {
  const raw = (body as { phone?: unknown } | undefined)?.phone;
  return typeof raw === "string" ? toE164(raw) : null;
}

router.post("/opt-out", async (req, res) => {
  const phone = phoneFrom(req.body);
  if (!phone) return res.status(400).json({ error: "That is not a phone number that can be texted." });
  await markOptedOut(phone, "staff", typeof req.body?.note === "string" ? req.body.note : null);
  res.json({ optedOut: true });
});

router.delete("/opt-out", async (req, res) => {
  const phone = phoneFrom(req.body);
  if (!phone) return res.status(400).json({ error: "That is not a phone number that can be texted." });
  await clearOptOut(phone);
  res.json({ optedOut: false });
});

router.get("/opt-out", async (req, res) => {
  const phone = typeof req.query.phone === "string" ? toE164(req.query.phone) : null;
  res.json({ phone, optedOut: phone ? await isOptedOut(phone) : false });
});

export default router;
