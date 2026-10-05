import type { Channel, SendClass } from "./triggers.js";

// When a message may go, by what kind of send it is. All in the business's
// own clock, America/New_York.
//   transactional: anytime. It answers something the customer just did.
//   reminder:      texts only 9 AM to 8 PM. Any day, Sunday included.
//   nurture:       texts only 9 AM to 8 PM, and nothing at all on Sunday
//                  (text or email).
// Emails are never held for quiet hours. A message that is not allowed now
// is logged as deferred and not sent; the hourly scheduler tries again.

export const QUIET_START_HOUR = 9;
export const QUIET_END_HOUR = 20; // exclusive: 8:00 PM is already too late

export function easternClock(now: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
  return { hour, weekday };
}

export type SendDecision = { allowed: true } | { allowed: false; status: "deferred_quiet_hours" | "deferred_sunday"; reason: string };

export function checkSendRules(sendClass: SendClass, channel: Channel, now: Date = new Date()): SendDecision {
  if (sendClass === "transactional") return { allowed: true };
  const { hour, weekday } = easternClock(now);
  if (sendClass === "nurture" && weekday === 0) {
    return { allowed: false, status: "deferred_sunday", reason: "Follow-up messages are not sent on Sundays." };
  }
  if (channel === "sms" && (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR)) {
    return { allowed: false, status: "deferred_quiet_hours", reason: "Texts of this kind only go out between 9 AM and 8 PM Eastern." };
  }
  return { allowed: true };
}
