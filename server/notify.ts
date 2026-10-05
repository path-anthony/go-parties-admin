import { getDefaultAccount } from "./account.js";
import { redact, safeErr } from "./log.js";
import { afterContractSend, contractSendAction, reallySent, sendFailureReason, type ContractSendAction, type ContractSendKind } from "./contractSend.js";
import { ContractError, markContractSent, prepareContract, type signContract } from "./contracts.js";
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
    console.error(`[notify] ${what} failed:`, safeErr(err));
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

export type ContractSendResult = {
  // The text outcome, for the log line the button shows.
  result: SendResult | null;
  action: ContractSendAction;
  // A link is out with the customer (it went now, or it had already gone).
  linkIsOut: boolean;
  // The booking was moved from Held to Contract Sent by this send.
  stageMoved: boolean;
  // The contract is already signed, so there was no link to send.
  signed: boolean;
  // Why nothing went, when nothing did.
  reason: string | null;
};

// Sends the customer their signing link, and keeps everything that depends on
// "the contract was sent" in step with whether it really was (the rules are in
// server/contractSend.ts). Used by the "Send contract link" button, by the
// stage being set to Contract Sent, and when a design request becomes a
// booking. A hand-pressed send always goes (it gets its own key); the others
// go once per booking. If the link can't be made (no policy text yet) the
// reason is logged as a skipped send.
export async function sendContract(target: { bookingId?: string; designRequestId?: string }, kind: ContractSendKind): Promise<ContractSendResult> {
  const nothing: ContractSendResult = { result: null, action: "nothing", linkIsOut: false, stageMoved: false, signed: false, reason: "the message could not be prepared" };
  const done = await guard("contract link", async (): Promise<ContractSendResult> => {
    const booking = target.bookingId ? await prisma.booking.findUnique({ where: { id: target.bookingId }, select: { phone: true, email: true, status: true, leadId: true } }) : null;
    const subject = booking ?? (target.designRequestId ? await prisma.designRequest.findUnique({ where: { id: target.designRequestId }, select: { phone: true, email: true } }) : null);
    if (!subject) return { ...nothing, reason: "not found" };
    const recordId = target.bookingId ?? `req:${target.designRequestId}`;
    const purpose = kind === "manual" ? "manual-contract-link" : kind === "stage" ? "stage-update" : "design-request-converted";
    const unique = kind === "manual" ? `:manual:${Date.now()}` : "";
    const ctx = { bookingId: target.bookingId ?? null, designRequestId: target.designRequestId ?? null };
    const recipient = { phone: subject.phone, email: subject.email };
    const bookingStage = booking?.status ?? null;
    try {
      const prepared = await prepareContract(target);
      // Ground truth for "already sent": a contract link that was really handed over.
      const earlier = await prisma.messageLog.findFirst({
        where: {
          status: "sent",
          ...(target.bookingId ? { bookingId: target.bookingId } : { designRequestId: target.designRequestId }),
          // Sends from before triggers were recorded have no trigger key; a
          // signing link in the text is what marks them.
          OR: [{ triggerKey: "contract_sent" }, { triggerKey: null, body: { contains: "/sign/" } }],
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, sentAt: true },
      });
      const action = contractSendAction(kind, { signed: prepared.signed, linkAlreadySent: earlier !== null });
      if (action === "send-signed-copy") {
        const outcomes = await sendTemplatedMessage("contract_signed", { ...ctx, extra: { contractPdfLink: prepared.link } }, recipient, `contract_signed:${recordId}${unique}`, { purpose });
        return { result: asSendResult(outcomes), action, linkIsOut: false, stageMoved: false, signed: true, reason: reallySent(outcomes) ? null : sendFailureReason(outcomes) };
      }
      const outcomes = action === "send-link" ? await sendTemplatedMessage("contract_sent", { ...ctx, extra: { contractLink: prepared.link } }, recipient, `contract_sent:${recordId}${unique}`, { purpose }) : [];
      const sent = reallySent(outcomes);
      const after = afterContractSend({ action, sent, linkAlreadySent: earlier !== null, bookingStage });
      let stageMoved = false;
      if (after.markSent) {
        await markContractSent(prepared.agreementId, earlier ? (earlier.sentAt ?? earlier.createdAt) : new Date());
      }
      if (after.moveStage && target.bookingId) {
        const moved = await prisma.booking.updateMany({ where: { id: target.bookingId, status: "Held" }, data: { status: "Contract Sent" } });
        stageMoved = moved.count > 0;
        if (stageMoved && booking?.leadId) {
          await prisma.leadActivity.create({ data: { leadId: booking.leadId, text: "Contract link sent to the customer. Stage moved to Contract Sent." } });
        }
      }
      const reason = action === "send-link" && !sent ? sendFailureReason(outcomes) : action === "nothing" && prepared.signed ? "the contract is already signed" : null;
      return { result: asSendResult(outcomes), action, linkIsOut: after.markSent, stageMoved, signed: prepared.signed, reason };
    } catch (err) {
      if (err instanceof ContractError) {
        console.warn(`[notify] contract link not sent: ${redact(err.message)}`);
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
        return { result: { logId: row.id, status: "skipped-no-policy", error: err.message }, action: "send-link", linkIsOut: false, stageMoved: false, signed: false, reason: err.message };
      }
      throw err;
    }
  });
  return done ?? nothing;
}

// Staff changed the stage (or ticked the retainer): tell the customer, if
// the status they'd read actually changed to one worth announcing. A move to
// Contract Sent is not handled here: it sends the contract link, and the
// booking route does that itself before it saves the stage (sendContract).
export async function notifyStageChange(bookingId: string, before: DisplayStatus, after: DisplayStatus): Promise<void> {
  if (before === after || after === "Contract Sent") return;
  await guard(`stage change to ${after}`, async () => {
    const trigger = STAGE_TRIGGER[after];
    if (!trigger) return;
    const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { phone: true, email: true } });
    if (!b) return;
    await sendTemplatedMessage(trigger, { bookingId }, { phone: b.phone, email: b.email }, `${trigger}:${bookingId}`, { purpose: "stage-update" });
  });
}

// A design request just landed from the storefront: tell the customer a
// person will be in touch. Text, and email when there is an address. Once per
// request.
export async function sendDesignRequestAck(designRequestId: string): Promise<void> {
  await guard("design request acknowledgement", async () => {
    const r = await prisma.designRequest.findUnique({ where: { id: designRequestId }, select: { phone: true, email: true } });
    if (!r) return;
    await sendTemplatedMessage("design_request_received", { designRequestId }, { phone: r.phone, email: r.email }, `design_request_received:${designRequestId}`, { purpose: "design-request-received" });
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
