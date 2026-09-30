import { getDefaultAccount } from "./account.js";
import { prisma } from "./db.js";
import { type MessageContext, buildMessageValues } from "./messageContext.js";
import { sendEmail, sendSms, type MessageLink } from "./messaging.js";
import { checkSendRules } from "./sendRules.js";
import { getEffectiveTemplates } from "./templates.js";
import { renderMessage } from "./tokens.js";
import { type Channel, mustGetTrigger } from "./triggers.js";

// The one way an automated message leaves the system.
//
//   sendTemplatedMessage(triggerKey, context, recipient, idempotencyKey)
//
// For each channel the recipient can be reached on it: find the wording
// (the admin's, else the default), stop if that channel is switched off,
// fill in the merge tokens and stop if any comes out empty, apply the
// sending rules for this kind of message (quiet hours, Sundays), then hand
// it to Twilio or the email webhook. Every outcome is one row in
// message_logs. The idempotency key is claimed with that row before
// anything is sent, so the same message can never go twice.
//
// idempotencyKey is the caller's base (triggerKey + record id); the channel
// is appended here. A row that was sent (or is in flight) makes the call a
// no-op. A row that was switched off, blocked, deferred, skipped or failed
// is reused and tried again, which is also how the scheduler will retry
// deferred sends.

export type Recipient = { phone?: string | null; email?: string | null };

export type SendOptions = {
  // Only these channels (default: every channel the recipient has).
  channels?: Channel[];
  // What to call it in the log and, for email, in the webhook payload.
  // Defaults to the trigger key; existing sends keep their old names, and
  // may name each channel separately.
  purpose?: string | Partial<Record<Channel, string>>;
  // The clock, for tests and for the scheduler to replay.
  now?: Date;
};

export type ChannelOutcome = {
  channel: Channel;
  status: string;
  logId: string;
  error?: string;
  duplicate?: boolean;
};

const IN_FLIGHT = new Set(["sent", "queued"]);

function linkFor(ctx: MessageContext): MessageLink {
  return { bookingId: ctx.bookingId ?? null, designRequestId: ctx.designRequestId ?? null, crewMemberId: ctx.crewMemberId ?? null, gigId: ctx.gigId ?? null };
}

// Takes the key. Returns the row to fill in, or null when the message has
// already gone (or is going) and must not be sent again.
async function claim(accountId: string, key: string, base: { channel: Channel; recipient: string; body: string; subject: string | null; purpose: string; triggerKey: string; journey: string; ctx: MessageContext }) {
  const data = {
    accountId,
    channel: base.channel,
    purpose: base.purpose,
    recipient: base.recipient,
    subject: base.subject,
    body: base.body,
    status: "queued",
    error: null,
    triggerKey: base.triggerKey,
    journey: base.journey,
    idempotencyKey: key,
    bookingId: base.ctx.bookingId ?? null,
    designRequestId: base.ctx.designRequestId ?? null,
    crewMemberId: base.ctx.crewMemberId ?? null,
    gigId: base.ctx.gigId ?? null,
    leadId: base.ctx.leadId ?? null,
  };
  try {
    return await prisma.messageLog.create({ data });
  } catch (err) {
    if ((err as { code?: unknown }).code !== "P2002") throw err;
  }
  // The key exists. Retry it only if it never actually went out, and win
  // the row with a conditional update so two callers can't both retry.
  const existing = await prisma.messageLog.findUnique({ where: { idempotencyKey: key } });
  if (!existing || IN_FLIGHT.has(existing.status)) return null;
  const won = await prisma.messageLog.updateMany({
    where: { id: existing.id, status: existing.status },
    data: { status: "queued", error: null, recipient: base.recipient, body: base.body, subject: base.subject, purpose: base.purpose },
  });
  return won.count === 1 ? existing : null;
}

async function settle(logId: string, status: string, error: string | null, extra?: { body?: string; subject?: string | null }) {
  await prisma.messageLog.update({ where: { id: logId }, data: { status, error, ...(extra ?? {}) } });
}

export async function sendTemplatedMessage(
  triggerKey: string,
  context: MessageContext,
  recipient: Recipient,
  idempotencyKey: string,
  options: SendOptions = {},
): Promise<ChannelOutcome[]> {
  const def = mustGetTrigger(triggerKey);
  const account = await getDefaultAccount();
  const now = options.now ?? new Date();
  const purposeFor = (channel: Channel) => (typeof options.purpose === "string" ? options.purpose : (options.purpose?.[channel] ?? triggerKey));
  const link = linkFor(context);

  const channels: Channel[] = (options.channels ?? (["sms", "email"] as Channel[])).filter((c) => (c === "sms" ? recipient.phone !== undefined : recipient.email !== undefined));
  if (channels.length === 0) return [];

  const templates = await getEffectiveTemplates(account.id, triggerKey);
  let values: Record<string, string> | null = null;
  const outcomes: ChannelOutcome[] = [];

  for (const channel of channels) {
    const tpl = templates[channel];
    const to = channel === "sms" ? (recipient.phone ?? "") : (recipient.email ?? "");
    const key = `${idempotencyKey}:${channel}`;
    const purpose = purposeFor(channel);
    // A channel that is off only because that is its default (email, for
    // most messages) is not logged: nothing was asked of it. One the admin
    // switched off on purpose is logged as skipped_disabled.
    if (!tpl.enabled && !tpl.hasRow) {
      outcomes.push({ channel, status: "skipped_disabled", logId: "" });
      continue;
    }
    const rowBase = { channel, recipient: to || "(none)", body: tpl.body, subject: channel === "email" ? tpl.subject : null, purpose, triggerKey, journey: def.journey, ctx: context };

    const row = await claim(account.id, key, rowBase);
    if (!row) {
      const existing = await prisma.messageLog.findUnique({ where: { idempotencyKey: key } });
      outcomes.push({ channel, status: existing?.status ?? "sent", logId: existing?.id ?? "", duplicate: true });
      continue;
    }

    try {
      if (!tpl.enabled) {
        await settle(row.id, "skipped_disabled", "This message is switched off in Settings.");
        outcomes.push({ channel, status: "skipped_disabled", logId: row.id });
        continue;
      }

      values ??= await buildMessageValues(account.id, context);
      const body = renderMessage(tpl.body, values, def.tokens);
      const subject = channel === "email" ? renderMessage(tpl.subject, values, def.tokens) : null;
      const empty = [...new Set([...body.empty, ...(subject?.empty ?? [])])];
      const notAllowed = [...new Set([...body.notAllowed, ...(subject?.notAllowed ?? [])])];
      if (empty.length > 0 || notAllowed.length > 0) {
        const why = [
          empty.length > 0 ? `No value for ${empty.map((t) => `{{${t}}}`).join(", ")}` : null,
          notAllowed.length > 0 ? `${notAllowed.map((t) => `{{${t}}}`).join(", ")} can't be used in this message` : null,
        ]
          .filter(Boolean)
          .join(". ");
        await settle(row.id, "blocked_missing_field", why, { body: body.text, subject: subject?.text ?? null });
        outcomes.push({ channel, status: "blocked_missing_field", logId: row.id, error: why });
        continue;
      }

      const decision = checkSendRules(def.sendClass, channel, now);
      if (!decision.allowed) {
        await settle(row.id, decision.status, decision.reason, { body: body.text, subject: subject?.text ?? null });
        outcomes.push({ channel, status: decision.status, logId: row.id, error: decision.reason });
        continue;
      }

      const meta = { triggerKey, journey: def.journey, leadId: context.leadId ?? null, idempotencyKey: key, logId: row.id };
      const result =
        channel === "sms"
          ? await sendSms({ to: recipient.phone, body: body.text, purpose, link, meta })
          : await sendEmail({ to: recipient.email, subject: subject?.text ?? "", body: body.text, purpose, pdfUrl: values["contract_pdf_link"] || null, link, meta });
      outcomes.push({ channel, status: result.status, logId: row.id, error: result.error });
    } catch (err) {
      // Nothing here may throw into the flow that asked for the message.
      const message = err instanceof Error ? err.message : "unexpected error";
      console.error(`[send] ${triggerKey} ${channel} failed:`, err);
      await settle(row.id, "failed", message).catch(() => undefined);
      outcomes.push({ channel, status: "failed", logId: row.id, error: message });
    }
  }
  return outcomes;
}
