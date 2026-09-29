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
    case "skipped-no-webhook":
      return "Not sent: the email webhook isn't set up. It is in the log as skipped.";
    default:
      return row.status;
  }
}

