import { prisma } from "./db.js";
import { BUSINESS_TIME_ZONE, todayEastern } from "./validate.js";

// Account-wide settings that the rest of the server reads. Today: the
// minimum booking notice and the rush contact phone.

export const DEFAULT_MIN_NOTICE_HOURS = 72;
export const MAX_NOTICE_HOURS = 24 * 365;
export const MAX_PHONE_LENGTH = 40;

export async function getSettings(accountId: string) {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      minBookingNoticeHours: true,
      rushContactPhone: true,
      fullReviewThreshold: true,
      reviewOccasions: true,
      depositPercentage: true,
      cancellationWindowDays: true,
      requireAgreementCheckbox: true,
      staffNotifyPhone: true,
      staffNotifyEmail: true,
      balanceReminderWindowDays: true,
    },
  });
  return {
    minBookingNoticeHours: account.minBookingNoticeHours,
    rushContactPhone: account.rushContactPhone,
    fullReviewThreshold: Number(account.fullReviewThreshold),
    reviewOccasions: account.reviewOccasions,
    depositPercentage: Number(account.depositPercentage),
    cancellationWindowDays: account.cancellationWindowDays,
    requireAgreementCheckbox: account.requireAgreementCheckbox,
    staffNotifyPhone: account.staffNotifyPhone,
    staffNotifyEmail: account.staffNotifyEmail,
    balanceReminderWindowDays: account.balanceReminderWindowDays,
  };
}

// Whole hours from now until the event day starts, both read on the
// Eastern wall clock (an event date has no time of day; its first moment
// is midnight Eastern). Negative once the day has begun.
export function hoursUntilEvent(dateText: string, now: Date = new Date()): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIME_ZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)]),
  );
  const nowWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const [y, m, d] = dateText.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - nowWall) / 3_600_000;
}

// A booking is rush when its event day starts less than minHours from
// now. Zero turns the rule off. A date before today (an admin entering
// history) is never rush; the flag is about bookings still to happen.
export function isRush(dateText: string, minHours: number, now: Date = new Date()): boolean {
  if (minHours <= 0) return false;
  if (dateText < todayEastern(now)) return false;
  return hoursUntilEvent(dateText, now) < minHours;
}

export async function rushFor(accountId: string, date: Date): Promise<boolean> {
  const { minBookingNoticeHours } = await getSettings(accountId);
  return isRush(date.toISOString().slice(0, 10), minBookingNoticeHours);
}
