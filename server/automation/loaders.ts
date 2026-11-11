import { getDefaultAccount } from "../account.js";
import { signingLink } from "../contracts.js";
import { prisma } from "../db.js";
import { composeValues, type LoadedRecords } from "../messageContext.js";
import { toE164 } from "../messaging.js";
import { optedOutSet } from "../optOuts.js";
import { getSettings } from "../settings.js";
import { amountsFor } from "../payments.js";
import { ensurePayToken, owedStep, payValues } from "../payLink.js";
import { displayStatus } from "../../src/lib/bookingStatus.js";
import { renderChannel } from "../sendTemplated.js";
import { effectiveFrom, loadTemplateRows } from "../templates.js";
import { mustGetTrigger, TRIGGERS, type Channel } from "../triggers.js";
import { todayEastern } from "../validate.js";
import { CREW_STEPS, DIGEST_TRIGGER, NURTURE_SOURCES, planBooking, planDigest, planGig, planLead, type Contact, type Facts, type LogFact, type Plan, type PlanSubject } from "./planner.js";
import { loadDigest } from "../notifications.js";
import { isWeddingBooking } from "../weddingDetails/logic.js";
import { addDays } from "./time.js";

// Loads records and facts from the database and hands them to the planner.
// Every admin view and the sender go through here, so they cannot disagree.

export type Journey = "lead" | "client" | "crew";

export type Planned = {
  journey: Journey;
  kind: "lead" | "booking" | "gig" | "digest";
  recordId: string;
  // Who or what it is, in plain English.
  name: string;
  // Where to open it in the admin.
  href: string;
  contact: Contact;
  plan: Plan;
  // What the sender needs to make the call.
  send: {
    context: { leadId?: string; bookingId?: string; crewMemberId?: string; gigId?: string; offerId?: string; extra?: Record<string, string> };
    afterSend?: "balance";
  };
};

const SCHEDULED = new Set<string>([
  "lead_nurture_day3",
  "lead_nurture_day10",
  "contract_unsigned_nudge",
  "balance_due_reminder",
  "retainer_reminder",
  "hold_unpaid_reminder",
  "event_week_reminder",
  "event_eve_reminder",
  "post_event_thanks",
  DIGEST_TRIGGER,
  "wedding_details_reminder_60",
  "wedding_details_reminder_35",
  ...CREW_STEPS.map((s) => s.key),
]);

// "Jane, 555-123-4567, jane@x.com" -> phone and email, best effort.
export function parseContact(text: string | null | undefined): Contact {
  if (!text) return { phone: null, email: null };
  const email = text.match(/[^\s,;<>()]+@[^\s,;<>()]+\.[^\s,;<>()]+/)?.[0] ?? null;
  const withoutEmail = email ? text.replace(email, " ") : text;
  const phoneText = withoutEmail.match(/\+?\d[\d\s().-]{8,}\d/)?.[0] ?? null;
  return { phone: toE164(phoneText), email };
}

const asContact = (phone: string | null | undefined, email: string | null | undefined): Contact => ({ phone: toE164(phone), email: email?.trim() || null });

type Loaded = {
  accountId: string;
  facts: Facts;
  settings: Awaited<ReturnType<typeof getSettings>>;
  balanceWindowDays: number;
  stageNames: string[];
};

async function loadBase(now: Date, opts: { windowDays?: number } = {}): Promise<Loaded & { valuesFor(subject: PlanSubject, rec: LoadedRecords): void }> {
  const account = await getDefaultAccount();
  const [acct, settings, rows, opted, logRows] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: account.id }, select: { automationStartedAt: true, balanceReminderWindowDays: true } }),
    getSettings(account.id),
    loadTemplateRows(account.id),
    optedOutSet(account.id),
    prisma.messageLog.findMany({
      where: { accountId: account.id, idempotencyKey: { not: null }, triggerKey: { in: [...SCHEDULED] } },
      select: { idempotencyKey: true, status: true, attempts: true, sentAt: true, error: true, createdAt: true },
    }),
  ]);
  const logs = new Map<string, LogFact>();
  for (const l of logRows) logs.set(l.idempotencyKey as string, { status: l.status, attempts: l.attempts, sentAt: l.sentAt ?? (l.status === "sent" ? l.createdAt : null), error: l.error });

  const effective = new Map(TRIGGERS.map((t) => [t.key, effectiveFrom(t.key, rows)]));
  const stageNames = (await prisma.leadStatus.findMany({ where: { accountId: account.id }, select: { name: true } })).map((s) => s.name);

  // Merge-token values per record, gathered as records are planned.
  const values = new Map<string, Record<string, string>>();
  const facts: Facts = {
    now,
    automationStartedAt: acct.automationStartedAt,
    log: (k, c) => logs.get(`${k}:${c}`),
    channelOn: (t, c) => effective.get(t)?.[c].enabled ?? false,
    optedOut: (p) => opted.has(p),
    blockedReason: (t, c: Channel, subject) => {
      const v = values.get(`${subject.kind}:${subject.id}`);
      if (!v) return null;
      return renderChannel(mustGetTrigger(t), effective.get(t)![c], c, v).why;
    },
  };
  return {
    accountId: account.id,
    facts,
    settings,
    balanceWindowDays: opts.windowDays ?? acct.balanceReminderWindowDays,
    stageNames,
    valuesFor: (subject, rec) => values.set(`${subject.kind}:${subject.id}`, composeValues(settings, rec)) && undefined,
  };
}

export type PlanScope = {
  now?: Date;
  windowDays?: number;
  leadId?: string;
  bookingId?: string;
  gigId?: string;
  // Only these kinds (default: all).
  kinds?: ("lead" | "booking" | "gig")[];
  // Leads: every lead (for the list chips) or only those in the journey.
  allLeads?: boolean;
};

const dayText = (d: Date) => d.toISOString().slice(0, 10);

// Block F3a: a booking says where it was made (origin). One made before F3a
// has none and still reads its lead's source, as it always did.
export const madeInStore = (b: { origin: string | null; lead?: { source: string } | null }): boolean => (b.origin ? b.origin === "storefront" : b.lead?.source === "storefront");

export async function loadPlans(scope: PlanScope = {}): Promise<Planned[]> {
  const now = scope.now ?? new Date();
  const base = await loadBase(now, { windowDays: scope.windowDays });
  const kinds = scope.kinds ?? ["lead", "booking", "gig"];
  const specific = Boolean(scope.leadId || scope.bookingId || scope.gigId);
  const want = (k: "lead" | "booking" | "gig") => kinds.includes(k) && (!specific || (k === "lead" && scope.leadId) || (k === "booking" && scope.bookingId) || (k === "gig" && scope.gigId));
  const out: Planned[] = [];
  const cutoff = new Date(`${addDays(todayEastern(now), -7)}T00:00:00Z`);

  if (want("lead")) {
    const leads = await prisma.lead.findMany({
      where: { accountId: base.accountId, ...(scope.leadId ? { id: scope.leadId } : scope.allLeads ? {} : { source: { in: NURTURE_SOURCES } }) },
      include: { bookings: { select: { id: true } } },
    });
    for (const l of leads) {
      const contact = parseContact(l.contact);
      const subject: PlanSubject = { kind: "lead", id: l.id };
      base.valuesFor(subject, { lead: { customerName: l.customerName, occasion: l.occasion, dateOfInterest: l.dateOfInterest } });
      const plan = planLead(
        { id: l.id, source: l.source, createdAt: l.createdAt, stage: l.status, hasBooking: l.bookings.length > 0, paused: l.automationPaused, dateOfInterest: l.dateOfInterest ? dayText(l.dateOfInterest) : null, contact },
        base.facts,
      );
      out.push({ journey: "lead", kind: "lead", recordId: l.id, name: l.customerName?.trim() || "Lead", href: `/leads?lead=${l.id}`, contact, plan, send: { context: { leadId: l.id } } });
    }
  }

  if (want("booking")) {
    const bookings = await prisma.booking.findMany({
      where: { accountId: base.accountId, ...(scope.bookingId ? { id: scope.bookingId } : { eventDate: { gte: cutoff }, status: { notIn: ["Cancelled", "Released"] } }) },
      include: { agreement: { include: { contractDocument: { select: { documentJson: true } } } }, payments: true, designRequest: { include: { agreement: true } }, lead: { select: { source: true } }, package: { select: { occasions: true } }, weddingDetails: { select: { status: true } } },
    });
    for (const b of bookings) {
      const agreement = b.agreement ?? b.designRequest?.agreement ?? null;
      const contact = asContact(b.phone, b.email);
      const subject: PlanSubject = { kind: "booking", id: b.id };
      const contractLink = agreement?.signingToken ? signingLink(agreement.signingToken) : undefined;
      // Block F1: what is owed, the real balance, its due day and the pay
      // link, worked out the one way (amountsFor) for every money message.
      const money = amountsFor(b, b.payments, base.settings);
      const owed = owedStep(b, money);
      const payToken = b.payToken ?? (b.retainerRequestedAt || b.retainerPaid ? await ensurePayToken(b.id) : null);
      const extra = { ...(contractLink ? { contractLink } : {}), ...payValues({ ...b, payToken }, money, base.settings.balanceDueDays, base.settings.payLinksOpenStorefront) };
      base.valuesFor(subject, { booking: b, extra });
      const plan = planBooking(
        {
          id: b.id,
          createdAt: b.createdAt,
          eventDate: dayText(b.eventDate),
          stage: b.status === "Released" ? "Cancelled" : b.status,
          retainerPaid: b.retainerPaid,
          balancePaid: b.balancePaid,
          total: b.total === null ? null : Number(b.total),
          balancePref: b.balancePaymentPreference,
          paused: b.automationPaused,
          lastBalanceReminderAt: b.lastBalanceReminderAt,
          contact,
          contract: agreement ? { sentAt: agreement.contractSentAt, signed: agreement.contractStatus === "Signed" } : null,
          balanceWindowDays: base.balanceWindowDays,
          storefrontHeldUnsigned: madeInStore(b) && b.status === "Held" && agreement?.contractStatus !== "Signed" && displayStatus(b) !== "Confirmed",
          // Block F3a: a signed-in customer's own unpaid hold on the policy
          // path. (When staff or a signature already asked for the retainer,
          // the retainer reminders above cover it instead.)
          holdReminder: {
            enabled: base.settings.holdReminderEmails,
            eligible: madeInStore(b) && b.customerId !== null && b.tier === 1 && b.status === "Held" && b.retainerRequestedAt === null,
            owed: owed.step === "retainer",
          },
          retainer: {
            requestedAt: b.retainerRequestedAt,
            days: [base.settings.retainerReminderDay1, base.settings.retainerReminderDay2, base.settings.retainerReminderDay3],
            owed: owed.step === "retainer" || owed.step === "sign",
            waitingOnSignature: owed.step === "sign",
          },
          wedding: isWeddingBooking(b) ? { status: b.weddingDetails?.status ?? "not_started", hasAccount: b.customerId !== null } : null,
        },
        base.facts,
      );
      out.push({
        journey: "client",
        kind: "booking",
        recordId: b.id,
        name: b.customerName,
        href: `/bookings?booking=${b.id}`,
        contact,
        plan,
        send: { context: { bookingId: b.id, extra } },
      });
    }
  }

  if (want("gig")) {
    const offers = await prisma.gigOffer.findMany({
      where: {
        ...(scope.gigId ? { gigId: scope.gigId } : { status: "Accepted", gig: { eventDate: { gte: cutoff }, status: { not: "Cancelled" } } }),
        gig: { accountId: base.accountId, ...(scope.gigId ? {} : { eventDate: { gte: cutoff }, status: { not: "Cancelled" } }) },
      },
      include: { gig: { include: { booking: { select: { customerName: true, eventTime: true, address: true } } } }, crewMember: true },
      orderBy: { updatedAt: "asc" },
    });
    for (const o of offers) {
      const contact = asContact(o.crewMember.phone, o.crewMember.email);
      const subject: PlanSubject = { kind: "gig", id: o.gig.id };
      base.valuesFor(subject, { crew: { name: o.crewMember.name }, gig: o.gig, offer: { token: o.token, bidAmount: o.bidAmount, deadlineAt: o.deadlineAt } });
      const plan = planGig(
        {
          gigId: o.gig.id,
          crewMemberId: o.crewMemberId,
          eventDate: dayText(o.gig.eventDate),
          acceptedAt: o.updatedAt,
          offerStatus: o.status,
          gigStatus: o.gig.status,
          paused: o.gig.automationPaused,
          contact,
        },
        base.facts,
      );
      out.push({
        journey: "crew",
        kind: "gig",
        recordId: o.gig.id,
        name: `${o.crewMember.name}, ${o.gig.skill} for ${o.gig.booking.customerName}`,
        href: `/crew/gigs?gig=${o.gig.id}`,
        contact,
        plan,
        send: { context: { crewMemberId: o.crewMemberId, gigId: o.gig.id, offerId: o.id } },
      });
    }
  }

  // The staff digest belongs to the whole account, so a view of one record
  // or one kind never asks about it.
  if (!specific && !scope.kinds) {
    const digest = await loadDigest(now);
    const subject: PlanSubject = { kind: "digest", id: digest.day };
    base.valuesFor(subject, { extra: digest.extra });
    const contact: Contact = { phone: null, email: digest.email };
    out.push({ journey: "client", kind: "digest", recordId: digest.day, name: "Staff daily digest", href: "/notifications", contact, plan: planDigest(digest, base.facts), send: { context: { extra: digest.extra } } });
  }
  return out;
}
