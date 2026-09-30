import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { buildMessageValues, sampleValues } from "../messageContext.js";
import { defaultsFor } from "../templates.js";
import { TOKEN_CATALOG, camelToSnake, referencedTokens, renderMessage } from "../tokens.js";
import { TRIGGERS, type Channel, getTrigger } from "../triggers.js";
import { countSms } from "../../src/lib/sms.js";

const router = Router();
const MAX_SMS = 1600;
const MAX_EMAIL = 10_000;
const MAX_SUBJECT = 200;

const isChannel = (v: unknown): v is Channel => v === "sms" || v === "email";

// Every message the system can send, with its wording and switches. This
// is what Settings > Messages shows.
router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  const rows = await prisma.messageTemplate.findMany({ where: { accountId: account.id } });
  res.json({
    tokens: TOKEN_CATALOG,
    triggers: TRIGGERS.map((t) => {
      const build = (channel: Channel) => {
        const d = defaultsFor(t, channel);
        const row = rows.find((r) => r.triggerKey === t.key && r.channel === channel);
        return {
          enabled: row ? row.enabled : d.enabled,
          customized: !!row && (row.body !== null || (channel === "email" && row.subject !== null)),
          subject: channel === "email" ? (row?.subject ?? d.subject) : "",
          body: row?.body ?? d.body,
          defaultSubject: d.subject,
          defaultBody: d.body,
        };
      };
      return {
        key: t.key,
        journey: t.journey,
        sendClass: t.sendClass,
        label: t.label,
        when: t.when,
        stopsWhen: t.stopsWhen,
        tokens: t.tokens,
        wired: t.wired,
        unwiredReason: t.unwiredReason ?? null,
        note: t.note ?? null,
        sms: build("sms"),
        email: build("email"),
      };
    }),
  });
});

// Saves edited wording (and optionally the switch) for one channel of one
// message. Every token used has to be one this message may use.
router.put("/:key/:channel", async (req, res) => {
  const def = getTrigger(String(req.params.key));
  const channel = req.params.channel;
  if (!def || !isChannel(channel)) return res.status(404).json({ error: "message not found" });
  const { subject, body, enabled } = req.body ?? {};
  if (typeof body !== "string" || body.trim() === "" || body.length > (channel === "sms" ? MAX_SMS : MAX_EMAIL)) {
    return res.status(400).json({ error: `The message can't be empty and can be at most ${channel === "sms" ? MAX_SMS : MAX_EMAIL} characters.` });
  }
  if (channel === "email" && (typeof subject !== "string" || subject.trim() === "" || subject.length > MAX_SUBJECT)) {
    return res.status(400).json({ error: `The subject can't be empty and can be at most ${MAX_SUBJECT} characters.` });
  }
  if (enabled !== undefined && typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });

  const allowed = new Set(def.tokens.map(camelToSnake));
  const used = [...new Set([...referencedTokens(body), ...(channel === "email" ? referencedTokens(String(subject)) : [])])];
  const bad = used.filter((t) => !allowed.has(camelToSnake(t)));
  if (bad.length > 0) {
    return res.status(400).json({
      error: `${bad.map((t) => `{{${t}}}`).join(", ")} can't be used in this message. It can use: ${def.tokens.map((t) => `{{${t}}}`).join(", ")}.`,
      reason: "token-not-allowed",
    });
  }

  const account = await getDefaultAccount();
  const d = defaultsFor(def, channel);
  const data = { subject: channel === "email" ? String(subject).trim() : null, body, enabled: enabled ?? d.enabled };
  const saved = await prisma.messageTemplate.upsert({
    where: { accountId_triggerKey_channel: { accountId: account.id, triggerKey: def.key, channel } },
    create: { accountId: account.id, triggerKey: def.key, channel, ...data },
    update: data,
  });
  res.json({ ok: true, updatedAt: saved.updatedAt });
});

// Turns one channel of one message on or off without touching its wording.
router.patch("/:key/:channel", async (req, res) => {
  const def = getTrigger(String(req.params.key));
  const channel = req.params.channel;
  if (!def || !isChannel(channel)) return res.status(404).json({ error: "message not found" });
  if (typeof (req.body ?? {}).enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
  const enabled = req.body.enabled as boolean;
  const account = await getDefaultAccount();
  const where = { accountId_triggerKey_channel: { accountId: account.id, triggerKey: def.key, channel } };
  const existing = await prisma.messageTemplate.findUnique({ where });
  if (!existing && enabled === defaultsFor(def, channel).enabled) return res.json({ ok: true, enabled });
  await prisma.messageTemplate.upsert({ where, create: { accountId: account.id, triggerKey: def.key, channel, enabled }, update: { enabled } });
  res.json({ ok: true, enabled });
});

// Back to the default wording and the default switch. Deletes the row.
router.delete("/:key/:channel", async (req, res) => {
  const def = getTrigger(String(req.params.key));
  const channel = req.params.channel;
  if (!def || !isChannel(channel)) return res.status(404).json({ error: "message not found" });
  const account = await getDefaultAccount();
  await prisma.messageTemplate.deleteMany({ where: { accountId: account.id, triggerKey: def.key, channel } });
  const d = defaultsFor(def, channel);
  res.json({ ok: true, enabled: d.enabled, subject: d.subject, body: d.body });
});

// What the wording being edited would say, filled in from a real recent
// record where there is one and from sample values where there isn't.
// Sends nothing and saves nothing.
router.post("/:key/preview", async (req, res) => {
  const def = getTrigger(String(req.params.key));
  if (!def) return res.status(404).json({ error: "message not found" });
  const { channel, subject, body } = req.body ?? {};
  if (!isChannel(channel) || typeof body !== "string") return res.status(400).json({ error: "channel and body are required" });
  const account = await getDefaultAccount();

  let ctx: Parameters<typeof buildMessageValues>[1] = {};
  let record: { kind: string; label: string } | null = null;
  if (def.journey === "client") {
    const b = await prisma.booking.findFirst({ where: { accountId: account.id, status: { not: "Cancelled" } }, orderBy: { createdAt: "desc" }, select: { id: true, customerName: true } });
    if (b) {
      ctx = { bookingId: b.id };
      record = { kind: "booking", label: `${b.customerName}'s booking` };
    }
  } else if (def.journey === "lead") {
    const l = await prisma.lead.findFirst({ where: { accountId: account.id, customerName: { not: null } }, orderBy: { createdAt: "desc" }, select: { id: true, customerName: true } });
    if (l) {
      ctx = { leadId: l.id };
      record = { kind: "lead", label: `${l.customerName}'s lead` };
    }
  } else {
    const g = await prisma.gig.findFirst({ where: { accountId: account.id, status: { not: "Cancelled" } }, orderBy: { createdAt: "desc" }, select: { id: true, itemName: true, skill: true } });
    if (g) {
      const crew = await prisma.crewMember.findFirst({ where: { accountId: account.id, active: true, skills: { has: g.skill } }, select: { id: true, name: true } });
      ctx = { gigId: g.id, crewMemberId: crew?.id ?? null };
      record = { kind: "gig", label: `the ${g.skill} gig for ${g.itemName}${crew ? ` (${crew.name})` : ""}` };
    }
  }

  const real = await buildMessageValues(account.id, ctx);
  const sample = sampleValues();
  const fromSample: string[] = [];
  const merged: Record<string, string> = { ...real };
  for (const t of def.tokens) {
    const k = camelToSnake(t);
    if (!merged[k] || merged[k].trim() === "") {
      merged[k] = sample[k] ?? "";
      fromSample.push(t);
    }
  }
  const renderedBody = renderMessage(body, merged, def.tokens);
  const renderedSubject = channel === "email" ? renderMessage(String(subject ?? ""), merged, def.tokens) : null;
  res.json({
    subject: renderedSubject?.text ?? null,
    body: renderedBody.text,
    notAllowed: [...new Set([...renderedBody.notAllowed, ...(renderedSubject?.notAllowed ?? [])])],
    record,
    fromSample: fromSample.filter((t) => referencedTokens(body + (subject ?? "")).some((u) => camelToSnake(u) === camelToSnake(t))),
    sms: channel === "sms" ? countSms(renderedBody.text) : null,
  });
});

export default router;
