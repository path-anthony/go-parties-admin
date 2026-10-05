// The rules for sending a contract, as plain functions with no database in
// them, so they can be tested directly. server/notify.ts does what they say.
//
// One action, one consistent state:
//   - Only a real send marks a contract Sent and starts the 48-hour reminder
//     clock. Preparing a link or previewing the PDF does neither.
//   - A real send on a Held booking moves it to Contract Sent.
//   - A contract that is already signed is never sent again by a stage
//     change. The hand-pressed button sends the signed copy instead.

export type ContractSendKind =
  | "manual" // staff pressed "Send contract link"
  | "stage" // staff set the stage to Contract Sent
  | "conversion"; // a design request became a booking

export type ContractSendAction = "send-link" | "send-signed-copy" | "nothing";

export function contractSendAction(kind: ContractSendKind, state: { signed: boolean; linkAlreadySent: boolean }): ContractSendAction {
  if (state.signed) return kind === "manual" ? "send-signed-copy" : "nothing";
  // Setting the stage after the link already went (by the button, or when the
  // request was converted) records where things stand; it does not text the
  // customer a second time.
  if (kind === "stage" && state.linkAlreadySent) return "nothing";
  return "send-link";
}

// A send really happened when at least one channel handed the message over.
// Switched off, blocked, skipped (no Twilio, opted out) and failed do not count.
export function reallySent(outcomes: { status: string }[]): boolean {
  return outcomes.some((o) => o.status === "sent");
}

export type AfterSend = {
  // Mark the agreement Sent (and stamp when, the first time).
  markSent: boolean;
  // Move the booking from Held to Contract Sent.
  moveStage: boolean;
};

export function afterContractSend(input: { action: ContractSendAction; sent: boolean; linkAlreadySent: boolean; bookingStage: string | null }): AfterSend {
  const linkIsOut = (input.action === "send-link" && input.sent) || (input.action === "nothing" && input.linkAlreadySent);
  return { markSent: linkIsOut, moveStage: linkIsOut && input.bookingStage === "Held" };
}

// Why a link did not go, in words for staff.
export function sendFailureReason(outcomes: { status: string; error?: string }[]): string {
  const o = outcomes.find((x) => x.status !== "skipped_disabled") ?? outcomes[0];
  if (!o) return "there is no phone number or email address to send it to";
  if (o.status === "skipped_disabled") return "the Contract sent message is switched off in Messages, Templates";
  return o.error ?? o.status;
}
