import { getDefaultAccount } from "./account.js";
import { prisma } from "./db.js";
import { WEBHOOK_SECRET_HEADER } from "./webhookAuth.js";

// Everything the system sends to a person goes through here, and every
// attempt is written to message_logs, so admin has one place to see what
// went out. Two rules hold for both channels:
//   - a missing credential or URL means the send is SKIPPED and logged as
//     skipped, never recorded as sent and never thrown;
//   - nothing here throws into the flow that called it. A booking, a
//     signature or a stage change never fails because a text didn't go.

export type MessageLink = {
  bookingId?: string | null;
  designRequestId?: string | null;
  crewMemberId?: string | null;
  gigId?: string | null;
};

export type SendResult = { logId: string; status: string; error?: string };

// Where a send belongs in the pipeline. logId: an existing log row to fill
// in instead of writing a new one (the pipeline claims its idempotency key
// with a row before it sends).
export type SendMeta = {
  triggerKey?: string | null;
  journey?: string | null;
  leadId?: string | null;
  idempotencyKey?: string | null;
  logId?: string | null;
};

const TWILIO_TIMEOUT_MS = 10_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

// A US number in any common shape to +1XXXXXXXXXX. Anything already in
// +E.164 form is kept. Returns null when it can't be read as a number.
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

async function writeLog(data: {
  channel: "sms" | "email";
  purpose: string;
  recipient: string;
  subject?: string | null;
  body: string;
  status: string;
  error?: string | null;
  providerRef?: string | null;
  link?: MessageLink;
  meta?: SendMeta;
}): Promise<string> {
  const account = await getDefaultAccount();
  if (data.meta?.logId) {
    // The pipeline already wrote this row; the send fills in the outcome.
    const row = await prisma.messageLog.update({
      where: { id: data.meta.logId },
      data: { status: data.status, error: data.error ?? null, providerRef: data.providerRef ?? null, body: data.body, subject: data.subject ?? null, recipient: data.recipient },
    });
    return row.id;
  }
  const row = await prisma.messageLog.create({
    data: {
      accountId: account.id,
      channel: data.channel,
      purpose: data.purpose,
      recipient: data.recipient,
      subject: data.subject ?? null,
      body: data.body,
      status: data.status,
      error: data.error ?? null,
      providerRef: data.providerRef ?? null,
      bookingId: data.link?.bookingId ?? null,
      designRequestId: data.link?.designRequestId ?? null,
      crewMemberId: data.link?.crewMemberId ?? null,
      gigId: data.link?.gigId ?? null,
      triggerKey: data.meta?.triggerKey ?? null,
      journey: data.meta?.journey ?? null,
      leadId: data.meta?.leadId ?? null,
      idempotencyKey: data.meta?.idempotencyKey ?? null,
    },
  });
  return row.id;
}

async function safeLog(...args: Parameters<typeof writeLog>): Promise<string> {
  try {
    return await writeLog(...args);
  } catch (err) {
    // The log itself failing must not break the flow either.
    console.error("[messaging] could not write the message log:", err);
    return "";
  }
}

export async function sendSms(input: { to: string | null | undefined; body: string; purpose: string; link?: MessageLink; meta?: SendMeta }): Promise<SendResult> {
  const { body, purpose, link, meta } = input;
  const raw = input.to?.trim() || "";
  const to = toE164(input.to);

  if (!to) {
    const error = raw === "" ? "no phone number on file" : `"${raw}" is not a phone number that can be texted`;
    console.warn(`[sms] not sent (${purpose}): ${error}`);
    return { logId: await safeLog({ channel: "sms", purpose, recipient: raw || "(none)", body, status: "failed", error, link, meta }), status: "failed", error };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!token || !sid || !from) {
    const missing = [!sid && "TWILIO_ACCOUNT_SID", !token && "TWILIO_AUTH_TOKEN", !from && "TWILIO_PHONE_NUMBER"].filter(Boolean).join(", ");
    const status = !token ? "skipped-no-token" : "skipped-not-configured";
    const error = `${missing} not set, so nothing was sent`;
    console.warn(`[sms] SKIPPED (${purpose}) to ${to}: ${error}. Would have sent: ${body}`);
    return { logId: await safeLog({ channel: "sms", purpose, recipient: to, body, status, error, link, meta }), status, error };
  }

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok) {
      const error = `Twilio ${res.status}${json.code ? ` (${json.code})` : ""}: ${json.message ?? "request failed"}`;
      console.error(`[sms] FAILED (${purpose}) to ${to}: ${error}`);
      return { logId: await safeLog({ channel: "sms", purpose, recipient: to, body, status: "failed", error, link, meta }), status: "failed", error };
    }
    return { logId: await safeLog({ channel: "sms", purpose, recipient: to, body, status: "sent", providerRef: json.sid ?? null, link, meta }), status: "sent" };
  } catch (err) {
    const error = err instanceof Error ? err.message : "request failed";
    console.error(`[sms] FAILED (${purpose}) to ${to}: ${error}`);
    return { logId: await safeLog({ channel: "sms", purpose, recipient: to, body, status: "failed", error, link, meta }), status: "failed", error };
  }
}

// Email goes to an n8n webhook, not a provider. The POST carries a
// referenceId (the log row's id) so n8n can report back what happened to
// it at POST /api/webhooks/n8n/send-status. A signed contract travels as a
// link (pdfUrl), never as an attachment.
export async function sendEmail(input: {
  to: string | null | undefined;
  subject: string;
  body: string;
  purpose: string;
  pdfUrl?: string | null;
  link?: MessageLink;
  meta?: SendMeta;
}): Promise<SendResult> {
  const { subject, body, purpose, link, meta } = input;
  const to = input.to?.trim() ?? "";
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    const error = to === "" ? "no email address on file" : `"${to}" is not an email address`;
    console.warn(`[email] not sent (${purpose}): ${error}`);
    return { logId: await safeLog({ channel: "email", purpose, recipient: to || "(none)", subject, body, status: "failed", error, link, meta }), status: "failed", error };
  }

  const url = process.env.EMAIL_WEBHOOK_URL;
  if (!url) {
    const error = "EMAIL_WEBHOOK_URL is not set, so nothing was sent";
    console.warn(`[email] SKIPPED (${purpose}) to ${to}: ${error}. Subject: ${subject}`);
    return { logId: await safeLog({ channel: "email", purpose, recipient: to, subject, body, status: "skipped-no-webhook", error, link, meta }), status: "skipped-no-webhook", error };
  }

  // The row exists before the POST so n8n can report against its id.
  const logId = await safeLog({ channel: "email", purpose, recipient: to, subject, body, status: "queued", link, meta });
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.N8N_WEBHOOK_SECRET) headers[WEBHOOK_SECRET_HEADER] = process.env.N8N_WEBHOOK_SECRET;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        referenceId: logId,
        channel: "email",
        purpose,
        to,
        subject,
        body,
        ...(input.pdfUrl ? { pdfUrl: input.pdfUrl } : {}),
        ...(link?.bookingId ? { bookingId: link.bookingId } : {}),
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the email webhook answered ${res.status}`);
    if (logId) await prisma.messageLog.update({ where: { id: logId }, data: { status: "sent" } });
    return { logId, status: "sent" };
  } catch (err) {
    const error = err instanceof Error ? err.message : "request failed";
    console.error(`[email] FAILED (${purpose}) to ${to}: ${error}`);
    if (logId) await prisma.messageLog.update({ where: { id: logId }, data: { status: "failed", error } }).catch(() => undefined);
    return { logId, status: "failed", error };
  }
}
