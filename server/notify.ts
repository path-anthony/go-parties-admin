import { getDefaultAccount } from "./account.js";
import { ContractError, issueContract, type signContract } from "./contracts.js";
import { prisma } from "./db.js";
import type { SendResult } from "./messaging.js";
import { sendTemplatedMessage, type ChannelOutcome } from "./sendTemplated.js";
import { displayStatus, type DisplayStatus } from "../src/lib/bookingStatus.js";
import { todayEastern } from "./validate.js";

// The automatic messages, each now a trigger in server/triggers.ts sent
// through sendTemplatedMessage. This file decides WHEN each one fires and
// who it goes to; what it says lives in the registry and the admin's
// templates. Each is best effort: it is attempted, logged, and never throws
// into the flow that triggered it.

async function guard<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[notify] ${what} failed:`, err);
    return null;
  }
}

// The text outcome, in the shape callers of the old wrapper expected.
function asSendResult(outcomes: ChannelOutcome[]): SendResult | null {
  const sms = outcomes.find((o) => o.channel === "sms") ?? outcomes[0];
  return sms ? { logId: sms.logId, status: sms.status, error: sms.error } : null;
}

// stage the customer would read -> the message that announces it
const STAGE_TRIGGER: Partial<Record<DisplayStatus, string>> = {
  Signed: "contract_signed_recorded",
  "Retainer Paid": "retainer_paid",
  Confirmed: "booking_confirmed",
  Cancelled: "booking_cancelled",
};

// Sends the customer their signing link. Used when a design request becomes
// a booking, when the stage is set to Contract Sent, and by the manual
// "Send contract link" button. A hand-pressed send always goes (it gets its
// own key); an automatic one goes once per booking. If the link can't be
// made (no policy text yet) the reason is logged as a skipped send.
export async function sendContractLinkSms(target: { bookingId?: string; designRequestId?: string }, purpose: string): Promise<SendResult | null> {
  return guard("contract link", async () => {
    const subject = target.bookingId
      ? await prisma.booking.findUnique({ where: { id: target.bookingId }, select: { phone: true, email: true } })
      : await prisma.designRequest.findUnique({ where: { id: target.designRequestId as string }, select: { phone: true, email: true } });
    if (!subject) return null;
    const recordId = target.bookingId ?? `req:${target.designRequestId}`;
    const manual = purpose.startsWith("manual");
    const unique = manual ? `:manual:${Date.now()}` : "";
    const ctx = { bookingId: target.bookingId ?? null, designRequestId: target.designRequestId ?? null };
    const recipient = { phone: subject.phone, email: subject.email };
    try {
      const issued = await issueContract(target);
      if (issued.signed) {
        return asSendResult(await sendTemplatedMessage("contract_signed", { ...ctx, extra: { contractPdfLink: issued.link } }, recipient, `contract_signed:${recordId}${unique || ":again"}`, { purpose }));
      }
      return asSendResult(await sendTemplatedMessage("contract_sent", { ...ctx, extra: { contractLink: issued.link } }, recipient, `contract_sent:${recordId}${unique}`, { purpose }));
    } catch (err) {
      if (err instanceof ContractError) {
        console.warn(`[notify] contract link not sent: ${err.message}`);
        const account = await getDefaultAccount();
        const row = await prisma.messageLog.create({
          data: {
            accountId: account.id,
            channel: "sms",
            purpose,
            recipient: subject.phone ?? "(none)",
            body: "(not composed)",
            status: "skipped-no-policy",
            error: `contract link not sent: ${err.message}`,
            bookingId: ctx.bookingId,
            designRequestId: ctx.designRequestId,
            triggerKey: "contract_sent",
            journey: "client",
          },
        });
        return { logId: row.id, status: "skipped-no-policy", error: err.message };
      }
      throw err;
    }
  });
}

// Staff changed the stage (or ticked the retainer): tell the customer, if
// the status they'd read actually changed to one worth announcing.
export async function notifyStageChange(bookingId: string, before: DisplayStatus, after: DisplayStatus): Promise<void> {
  if (before === after) return;
  await guard(`stage change to ${after}`, async () => {
    if (after === "Contract Sent") {
      await sendContractLinkSms({ bookingId }, "stage-update");
      return;
    }
    const trigger = STAGE_TRIGGER[after];
    if (!trigger) return;
    const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { phone: true, email: true } });
    if (!b) return;
    await sendTemplatedMessage(trigger, { bookingId }, { phone: b.phone, email: b.email }, `${trigger}:${bookingId}`, { purpose: "stage-update" });
  });
}

// The contract was signed: thank the customer (text, and email if it is
// switched on), tell staff, and if that made the booking Confirmed say so.
export async function notifyContractSigned(agreement: { bookingId: string | null; designRequestId: string | null }, signed: Awaited<ReturnType<typeof signContract>>): Promise<void> {
  await guard("signed notifications", async () => {
    const account = await getDefaultAccount();
    const staff = await prisma.account.findUniqueOrThrow({ where: { id: account.id }, select: { staffNotifyPhone: true, staffNotifyEmail: true } });
    const c = signed.content;
    const ctx = { bookingId: agreement.bookingId, designRequestId: agreement.designRequestId, extra: { contractPdfLink: signed.pdfUrl } };
    const recordId = agreement.bookingId ?? `req:${agreement.designRequestId}`;

    await sendTemplatedMessage("contract_signed", ctx, { phone: c.customerPhone, email: c.customerEmail }, `contract_signed:${recordId}`, {
      purpose: { sms: "signed-confirmation", email: "signed-contract-customer" },
    });
    await sendTemplatedMessage("staff_contract_signed", ctx, { phone: staff.staffNotifyPhone, email: staff.staffNotifyEmail }, `staff_contract_signed:${recordId}`, {
      purpose: { sms: "signed-staff-notice", email: "signed-contract-staff" },
    });

    if (agreement.bookingId) {
      const b = await prisma.booking.findUnique({ where: { id: agreement.bookingId }, select: { status: true, retainerPaid: true, phone: true, email: true } });
      if (b && displayStatus(b) === "Confirmed") {
        await sendTemplatedMessage("booking_confirmed", { bookingId: agreement.bookingId }, { phone: b.phone, email: b.email }, `booking_confirmed:${agreement.bookingId}`, { purpose: "stage-update" });
      }
    }
  });
}

// Used by the reminder check. One per booking per Eastern day.
export async function sendBalanceReminder(bookingId: string): Promise<SendResult | null> {
  return guard("balance reminder", async () => {
    const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { phone: true, email: true, total: true } });
    if (!b || b.total === null) return null;
    return asSendResult(
      await sendTemplatedMessage("balance_due_reminder", { bookingId }, { phone: b.phone, email: b.email }, `balance_due_reminder:${bookingId}:${todayEastern()}`, { purpose: "balance-reminder" }),
    );
  });
}
