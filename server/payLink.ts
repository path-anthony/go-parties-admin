import { randomBytes } from "node:crypto";
import { actorFields } from "./actor.js";
import { apiBase } from "./contract/links.js";
import { daysBefore } from "./contract/goMoney.js";
import { prisma } from "./db.js";
import { safeErr } from "./log.js";
import { sendContract } from "./notify.js";
import { loadMoney, type Money } from "./payments.js";
import { sendTemplatedMessage } from "./sendTemplated.js";

// Block F1. The pay link: one private address per booking that takes the
// customer to whatever they owe next. Sign the contract if one is needed and
// unsigned, then the retainer, then the balance. It works without an account,
// the same way the contract link does (an unguessable token on the booking).
//
// Nothing here charges a card. The link opens Stripe's own payment page and
// the customer pays there; the app only learns the result from Stripe.

export const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const newToken = () => randomBytes(24).toString("base64url");

export async function ensurePayToken(bookingId: string): Promise<string> {
  const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { payToken: true } });
  if (b.payToken) return b.payToken;
  const token = newToken();
  // Two requests racing to make the first token: whichever wrote first wins.
  await prisma.booking.updateMany({ where: { id: bookingId, payToken: null }, data: { payToken: token } });
  return (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { payToken: true } })).payToken as string;
}

export const payLinkFor = (token: string): string => `${apiBase()}/pay/${token}`;

// "Thu, Sep 10": the day the balance is due, from the event day and the
// balance due setting.
export function balanceDueDateText(eventDate: Date, balanceDueDays: number): string {
  return new Date(`${daysBefore(eventDate.toISOString().slice(0, 10), balanceDueDays)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// The values a message about money needs, for one booking: the link, what is
// owed now, the real balance and its due day. Pure.
export function payValues(b: { payToken: string | null; eventDate: Date; status: string; tier: number | null; agreement?: { contractStatus: string | null } | null }, money: Money, balanceDueDays: number): Record<string, string> {
  const owed = owedStep(b, money);
  const out: Record<string, string> = { balanceDueDate: balanceDueDateText(b.eventDate, balanceDueDays) };
  if (b.payToken) out.payLink = payLinkFor(b.payToken);
  if (owed.amountCents !== null) out.amountDue = usd(owed.amountCents);
  if (money.balanceDueCents !== null) out.balanceDue = usd(money.balanceDueCents);
  return out;
}

export type OwedStep = "closed" | "sign" | "retainer" | "balance" | "nothing";
export type Owed = { step: OwedStep; amountCents: number | null };

const inactive = (status: string) => status === "Cancelled" || status === "Released" || status === "Completed";

// Pure. What the customer owes next, from the booking and its money. The
// amounts are the ones amountsFor worked out; nothing is recalculated here.
export function owedStep(b: { status: string; tier: number | null; agreement?: { contractStatus: string | null } | null }, money: Money): Owed {
  if (inactive(b.status)) return { step: "closed", amountCents: null };
  const retainerLeft = money.retainerDueCents === null ? 0 : Math.max(0, money.retainerDueCents - money.retainerPaidCents);
  if (!money.retainerPaid && retainerLeft > 0) {
    // A contract booking signs first; the retainer waits for the signature.
    if (b.tier === 2 && b.agreement?.contractStatus !== "Signed") return { step: "sign", amountCents: retainerLeft };
    return { step: "retainer", amountCents: retainerLeft };
  }
  if (!money.balancePaid && money.balanceDueCents !== null && money.balanceDueCents > 0) return { step: "balance", amountCents: money.balanceDueCents };
  return { step: "nothing", amountCents: null };
}

export async function owedFor(bookingId: string) {
  const { booking, money, settings } = await loadMoney(bookingId);
  return { ...owedStep(booking, money), booking, money, settings };
}

export type PayLinkSend = { step: OwedStep; amountCents: number | null; sent: boolean; why: string | null };

const WHY_NOT: Record<string, string> = {
  closed: "This booking is cancelled or finished, so nothing is owed.",
  nothing: "Nothing is owed on this booking right now.",
};

// Sends the customer the link for what they owe, by text and email, with the
// amount. "created": staff just made the booking or turned a request into
// one. "signed": the customer just signed and the retainer is unpaid.
// "manual": staff pressed Send pay link. The automatic ones go once each; a
// hand-pressed send always goes. Never throws.
export async function sendPayLink(bookingId: string, why: "created" | "signed" | "manual"): Promise<PayLinkSend> {
  try {
    const owed = await owedFor(bookingId);
    const { booking } = owed;
    if (owed.step === "closed" || owed.step === "nothing" || owed.amountCents === null) return { step: owed.step, amountCents: null, sent: false, why: WHY_NOT[owed.step] ?? WHY_NOT.nothing };
    const payLink = payLinkFor(await ensurePayToken(bookingId));
    const amountDue = usd(owed.amountCents);
    const recipient = { phone: booking.phone, email: booking.email };
    const manual = why === "manual" ? `:manual:${Date.now()}` : "";
    let sent = false;
    let reason: string | null = null;
    if (owed.step === "sign") {
      // The contract comes first. This is still the one contract send (it
      // marks the contract sent and moves a Held booking to Contract Sent);
      // the message also says the retainer amount and carries the pay link.
      const r = await sendContract({ bookingId }, why === "manual" ? "manual" : "conversion", { amountDue });
      sent = r.linkIsOut && r.action === "send-link" && r.reason === null;
      reason = r.reason;
    } else {
      const trigger = owed.step === "retainer" ? "retainer_requested" : "pay_link_balance";
      const balanceDueDate = balanceDueDateText(booking.eventDate, owed.settings.balanceDueDays);
      const outcomes = await sendTemplatedMessage(trigger, { bookingId, extra: { payLink, amountDue, balanceDueDate } }, recipient, `${trigger}:${bookingId}${manual || `:${why}`}`, { purpose: "pay-link" });
      sent = outcomes.some((o) => o.status === "sent");
      if (!sent) {
        const o = outcomes.find((x) => x.status !== "skipped_disabled") ?? outcomes[0];
        reason = !o ? "There is no phone number or email address to send it to." : o.status === "skipped_disabled" ? "That message is switched off in Messages, Templates." : (o.error ?? o.status);
      }
    }
    if (sent) {
      const who = actorFields();
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          payLinkSentAt: new Date(),
          payLinkSentByName: why === "manual" ? (who.userName ?? "staff") : "Sent automatically",
          // The retainer reminders count from the first time it was asked for.
          ...(owed.step === "retainer" && !booking.retainerRequestedAt ? { retainerRequestedAt: new Date() } : {}),
        },
      });
    }
    return { step: owed.step, amountCents: owed.amountCents, sent, why: reason };
  } catch (err) {
    console.warn("[pay link] not sent:", safeErr(err));
    return { step: "nothing", amountCents: null, sent: false, why: "The pay link could not be prepared." };
  }
}
