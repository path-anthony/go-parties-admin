import type { MessageLogRow } from "./types";

// What the log row says, in a plain sentence, so nobody has to guess
// whether a text actually went.
export function describeSend(row: MessageLogRow): string {
  switch (row.status) {
    case "sent":
      return row.channel === "sms" ? "Handed to Twilio. Delivery isn't confirmed here." : "Handed to the email webhook.";
    case "failed":
      return `Did not send: ${row.error ?? "unknown error"}.`;
    case "skipped-no-token":
      return "Not sent: Twilio isn't fully set up yet (no auth token). It is in the log as skipped.";
    case "skipped-not-configured":
      return "Not sent: Twilio settings are missing. It is in the log as skipped.";
    case "skipped-no-policy":
      return `Not sent: ${row.error ?? "the policy text is empty"}.`;
    case "skipped_disabled":
      return "Not sent: this message is switched off in Settings.";
    case "blocked_missing_field":
      return `Not sent: ${row.error ?? "a piece of information is missing"}.`;
    case "deferred_quiet_hours":
    case "deferred_sunday":
      return `Held, not sent: ${row.error ?? "outside the sending hours"}`;
    case "skipped-no-webhook":
      return "Not sent: the email webhook isn't set up. It is in the log as skipped.";
    default:
      return row.status;
  }
}


// Short label and colour class for a log status. Our own attempt statuses
// (sent, failed, skipped-*) and the pipeline's (switched off, blocked,
// held for quiet hours or a Sunday).
export function statusLabel(status: string): string {
  return (
    {
      sent: "Sent",
      failed: "Failed",
      queued: "In progress",
      skipped_disabled: "Switched off",
      blocked_missing_field: "Blocked: missing info",
      deferred_quiet_hours: "Held: quiet hours",
      deferred_sunday: "Held: Sunday",
      "skipped-no-token": "Not sent: no Twilio token",
      "skipped-not-configured": "Not sent: Twilio not set up",
      "skipped-no-webhook": "Not sent: no email webhook",
      "skipped-no-policy": "Not sent: no policy text",
    } as Record<string, string>
  )[status] ?? status;
}

export function statusClass(status: string): string {
  if (status === "sent") return "msg-sent";
  if (status === "failed") return "msg-failed";
  if (status === "queued") return "msg-queued";
  return "msg-skipped";
}
