import { getDefaultAccount } from "./account.js";
import { ContractError, issueContract, type signContract } from "./contracts.js";
import { prisma } from "./db.js";
import { sendEmail, sendSms, type SendResult } from "./messaging.js";
import { getSettings } from "./settings.js";
import type { DisplayStatus } from "../src/lib/bookingStatus.js";

// The automatic messages. Each one is best effort: it is attempted, logged
// in message_logs, and if it can't go (no credentials, no phone number, no
// policy text) the reason is logged and the flow that triggered it carries
// on. Nothing here throws.

const COMPANY = "GO! Event Group";

const firstName = (full: string) => full.trim().split(/\s+/)[0] || "there";
const shortDate = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

// What each stage change tells the customer. Short, plain, no exclamation
// points. Held and Completed are not announced.
export function stageText(status: DisplayStatus, ctx: { first: string; date: string; link?: string | null }): string | null {
  switch (status) {
    case "Contract Sent":
      return `Hi ${ctx.first}, your ${COMPANY} contract for ${ctx.date} is ready to review and sign${ctx.link ? `: ${ctx.link}` : "."}`;
    case "Signed":
      return `Thanks ${ctx.first}, we have your signed contract for ${ctx.date}. The next step is the retainer payment to confirm your date.`;
    case "Retainer Paid":
      return `Hi ${ctx.first}, we received your retainer for ${ctx.date}. Thank you. Your date is confirmed once the contract is signed too.`;
    case "Confirmed":
      return `Hi ${ctx.first}, your ${COMPANY} booking for ${ctx.date} is confirmed. We're looking forward to your event.`;
    case "Cancelled":
      return `Hi ${ctx.first}, your ${COMPANY} booking for ${ctx.date} has been cancelled. If that doesn't look right, please call or text us.`;
    default:
      return null;
  }
}

async function guard<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[notify] ${what} failed:`, err);
    return null;
  }
}

// Sends the customer their signing link by text. Used when a design
// request becomes a booking, when the stage is set to Contract Sent, and
// by the manual "Send contract link" button. If the link can't be made
// (no policy text yet) the reason is logged as a skipped send.
export async function sendContractLinkSms(target: { bookingId?: string; designRequestId?: string }, purpose: string): Promise<SendResult | null> {
  return guard("contract link", async () => {
    const subject = target.bookingId
      ? await prisma.booking.findUnique({ where: { id: target.bookingId }, select: { customerName: true, phone: true, eventDate: true } })
      : await prisma.designRequest.findUnique({ where: { id: target.designRequestId as string }, select: { customerName: true, phone: true, eventDate: true } });
    if (!subject) return null;
    const link = { bookingId: target.bookingId ?? null, designRequestId: target.designRequestId ?? null };
    try {
      const issued = await issueContract(target);
      if (issued.signed) {
        return sendSms({ to: subject.phone, body: `Hi ${firstName(subject.customerName)}, your ${COMPANY} contract for ${shortDate(subject.eventDate)} is already signed. Thank you.`, purpose, link });
      }
      const body = stageText("Contract Sent", { first: firstName(subject.customerName), date: shortDate(subject.eventDate), link: issued.link }) as string;
      return sendSms({ to: subject.phone, body, purpose, link });
    } catch (err) {
      if (err instanceof ContractError) {
        console.warn(`[notify] contract link not sent: ${err.message}`);
        const { logId } = await sendSmsSkipped(subject.phone, purpose, `contract link not sent: ${err.message}`, link);
        return { logId, status: "skipped-no-policy", error: err.message };
      }
      throw err;
    }
  });
}

// A send that never started because something upstream wasn't ready. It
// is still logged, so nobody assumes the customer was told.
async function sendSmsSkipped(to: string | null, purpose: string, reason: string, link: { bookingId: string | null; designRequestId: string | null }) {
  const account = await getDefaultAccount();
  const row = await prisma.messageLog.create({
    data: { accountId: account.id, channel: "sms", purpose, recipient: to ?? "(none)", body: "(not composed)", status: "skipped-no-policy", error: reason, bookingId: link.bookingId, designRequestId: link.designRequestId },
  });
  return { logId: row.id };
}

// Staff changed the stage (or ticked the retainer): tell the customer,
// if the status they'd read actually changed to one worth announcing.
export async function notifyStageChange(bookingId: string, before: DisplayStatus, after: DisplayStatus): Promise<void> {
  if (before === after) return;
  await guard(`stage change to ${after}`, async () => {
    if (after === "Contract Sent") {
      await sendContractLinkSms({ bookingId }, "stage-update");
      return;
    }
    const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { customerName: true, phone: true, eventDate: true } });
    if (!b) return;
    const body = stageText(after, { first: firstName(b.customerName), date: shortDate(b.eventDate) });
    if (!body) return;
    await sendSms({ to: b.phone, body, purpose: "stage-update", link: { bookingId } });
  });
}

// The contract was signed: thank the customer (text and email with the
// PDF link) and tell staff.
export async function notifyContractSigned(agreement: { bookingId: string | null; designRequestId: string | null }, signed: Awaited<ReturnType<typeof signContract>>): Promise<void> {
  await guard("signed notifications", async () => {
    const account = await getDefaultAccount();
    const settings = await prisma.account.findUniqueOrThrow({ where: { id: account.id }, select: { staffNotifyPhone: true, staffNotifyEmail: true } });
    const c = signed.content;
    const link = { bookingId: agreement.bookingId, designRequestId: agreement.designRequestId };
    const when = shortDate(new Date(`${c.eventDate}T00:00:00Z`));
    const first = firstName(c.customerName);

    await sendSms({ to: c.customerPhone, body: `Thanks ${first}, your ${COMPANY} contract for ${when} is signed. Your copy: ${signed.pdfUrl}`, purpose: "signed-confirmation", link });
    await sendEmail({
      to: c.customerEmail,
      subject: `Your signed ${COMPANY} contract`,
      body: `Hi ${first},\n\nThanks for signing. Your signed contract for ${when} is at the link below. Keep it for your records.\n\n${signed.pdfUrl}\n\n${COMPANY}`,
      purpose: "signed-contract-customer",
      pdfUrl: signed.pdfUrl,
      link,
    });

    const notice = `${c.customerName} signed the contract for ${when}. ${signed.pdfUrl}`;
    await sendSms({ to: settings.staffNotifyPhone, body: `Signed: ${notice}`, purpose: "signed-staff-notice", link });
    await sendEmail({
      to: settings.staffNotifyEmail,
      subject: `Contract signed: ${c.customerName}, ${when}`,
      body: `${notice}\n\nSigned copy: ${signed.pdfUrl}`,
      purpose: "signed-contract-staff",
      pdfUrl: signed.pdfUrl,
      link,
    });
  });
}

// A gig offer goes out as a real text to the crew member.
export async function sendGigOfferSms(input: { crew: { id: string; name: string; phone: string | null }; gig: { id: string; skill: string; itemName: string; eventDate: Date } }): Promise<SendResult | null> {
  return guard("gig offer", async () => {
    const body = `Hi ${firstName(input.crew.name)}, ${COMPANY} has a ${input.gig.skill} gig for ${input.gig.itemName} on ${shortDate(input.gig.eventDate)}. Can you take it? Please call or text us back to say yes or no.`;
    return sendSms({ to: input.crew.phone, body, purpose: "gig-offer", link: { crewMemberId: input.crew.id, gigId: input.gig.id } });
  });
}

// Used by the reminder check.
export async function sendBalanceReminder(bookingId: string): Promise<SendResult | null> {
  return guard("balance reminder", async () => {
    const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { customerName: true, phone: true, eventDate: true, total: true, accountId: true } });
    if (!b || b.total === null) return null;
    const settings = await getSettings(b.accountId);
    const balance = Math.round(Number(b.total) * (100 - settings.depositPercentage)) / 100;
    const amount = balance.toLocaleString("en-US", { style: "currency", currency: "USD" });
    const body = `Hi ${firstName(b.customerName)}, a reminder that the remaining balance of ${amount} for your ${COMPANY} event on ${shortDate(b.eventDate)} is coming due. Please call or text us to arrange payment.`;
    return sendSms({ to: b.phone, body, purpose: "balance-reminder", link: { bookingId } });
  });
}
