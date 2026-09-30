# Contracts, texts and email: contracts for the storefront and n8n

Environment (Railway): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (not set yet, so texts are logged as skipped), `TWILIO_PHONE_NUMBER`, `EMAIL_WEBHOOK_URL` (not set yet, so emails are logged as skipped), `N8N_WEBHOOK_SECRET` (shared secret, header `x-webhook-secret`), `STOREFRONT_URL` (where the signing page lives; the link texted is `${STOREFRONT_URL}/sign/<token>`), optional `PUBLIC_API_URL` (base of the PDF links; defaults to the Railway public domain, then the request host).

## Storefront: signing (public, no session)

`GET /api/contracts/:token` returns, while unsigned:

    { status: "Sent", signed: false, title, customerName, eventDate, eventTime, address,
      items: [{ name, quantity, unitPrice|null }], addons: [{ itemName, groupName, addonName, priceDelta, quantity }],
      total|null, depositPercentage, depositAmount|null, balanceAmount|null, cancellationWindowDays,
      policyVersion, sections: [{ heading, body }], text, contentHash, consentText, termsText }

and once signed: `{ status: "Signed", signed: true, title, text, signedName, signedAt, pdfUrl }`.
404 for an unknown token. 409 `no-policy` if the policy text is empty.

`POST /api/contracts/:token/sign` with `{ fullName, consentToElectronicSignature: true, agreeToTerms: true, contentHash? }`
(consent to sign electronically and agreement to the terms are separate booleans, both required; fullName is first and last;
contentHash, if sent, must match what was shown). 201 `{ signed: true, signedAt, signedName, documentId, pdfUrl }`.
400 with `reason`: `name-required`, `consent-required`, `terms-required`. 409 with `reason`: `already-signed`, `contract-changed`, `no-policy`. 404 bad token.
IP and time are taken from the request. `GET /api/contracts/pdf/:downloadToken` serves the stored PDF.

## n8n

Email out: when `EMAIL_WEBHOOK_URL` is set, `POST` with header `x-webhook-secret` and JSON
`{ referenceId, channel: "email", purpose, to, subject, body, pdfUrl?, bookingId? }`. Any 2xx counts as handed over.
A signed contract goes as `pdfUrl` (a link), never an attachment.

Status in: `POST /api/webhooks/n8n/send-status` (header `x-webhook-secret`)
`{ channel: "sms"|"email", recipient, success: boolean, referenceId?, detail?, providerId?, occurredAt? }`.
`referenceId` is the one we sent. Matched: 200 `{ ok, matched: true, logId, confirmation }`. Unmatched (a send n8n made itself): 201 `{ ok, matched: false, logId, confirmation }`.

Scheduler: `POST /api/automations/check-reminders` (header `x-webhook-secret`), hourly from n8n. Optional `?dryRun=true`
(or `dryRun` in the body) sends and logs nothing; optional body `windowDays` (0-120) overrides how far ahead of the event balance
reminders start. It plans lead nurture, client and crew messages with `server/automation/planner.ts` and sends what is due through
`sendTemplatedMessage`. Returns `{ dryRun, ranAt, durationMs, counts: { lead, client, crew, total }, lines: [...], needsAttention }`.
Staff can run the same code from Messages > Upcoming ("Run check now": preview, then confirm).

Email purposes: scheduled sends use the trigger key as `purpose` (`event_week_reminder`, `balance-reminder`, and so on). The payload is
otherwise unchanged. Open risk: I can't inspect the n8n workflow; it must forward any `subject` and `body` generically, not only the
signed-contract email, or the new emails will not arrive.

## How the scheduler decides (server/automation/planner.ts)

One pure function per record type (`planLead`, `planBooking`, `planGig`) returns every planned message with a state: sent, scheduled,
due, skipped (with a code and reason), blocked, stopped, paused, waiting, failed_final. The sender and every admin view call it.

- Leads: only source `manual`. Day 3 and day 10 at 10 AM Eastern; a Sunday moves to Monday. Stops when the lead has a booking, sits in the
  column named "Booked" or "Lost" (matched by name, ignoring case), or is paused.
- Clients: contract nudge 48 hours after `Agreement.contractSentAt` if unsigned; event week (E-7), eve (E-1) and thanks (E+1) at 10 AM,
  only for Retainer Paid or Confirmed; balance reminders every 3 days from `balanceReminderWindowDays` before the event while a balance is open.
- Crew: Accepted offers only. 30, 15, 7 and 3 days before at 10 AM, the day before at 6 PM. Text only by default. Blocked until `gigLink` exists (Block 3).
- Catch-up: an overdue message goes only if the next one in its series is not yet due and the event has not started. The last message in a series
  is dropped if it would go more than 3 days late. Nothing before the record entered automation (`Account.automationStartedAt` or its own creation/acceptance).
- Event reminder keys include the event date, so a reschedule produces a fresh set.
- Failed sends retry on later runs, 3 attempts in all (`message_logs.attempts`), then `failed_final` (counted as "Needs attention").
- Opt-outs: Twilio error 21610 stores the number in `sms_opt_outs`; every later text to it is `skipped_opted_out` before Twilio is called. Staff can mark or unmark a number.

## Merge fields in the policy text

`{{customer_name}} {{event_date}} {{event_time}} {{event_address}} {{total}} {{deposit_percentage}} {{deposit_amount}} {{balance_amount}} {{cancellation_window_days}}`,
also in camelCase. `deposit_percentage` is a bare number (write the % yourself). Unknown fields are left as typed.

## Crew bidding (Block 3)

Public API for the storefront's crew page, by the offer's unguessable token (no credentials, plain fetch, CORS from `ALLOWED_ORIGINS`):
`GET /api/bids/:token`, `PUT /api/bids/:token/bid {amount, note?}`, `POST .../decline`, `POST .../confirm` (`{confirmedAt}`), `POST .../question {text}` (`{ok:true}`).
Errors are `{ error, reason }`, reason one of `deadline-passed`, `already-filled`, `bid-invalid`, `not-open`, `rate-limited`. Unknown or expired token: 404.
A link works through the end of the second day after the gig (Eastern). Link format: `STOREFRONT_URL/bid/<32 character token>`.

The GET response is built in one serializer (`serializeBid` in `server/bids.ts`). Address, arrival notes, contact phone, crew first name, confirmedAt and questions
appear only when the offer is accepted. Customer name, phone, email and the booking id are never read by it. `server/tests/bids.test.ts` asserts this for every state.

Stored offer status -> page state: Sent with no bid and time left = open; Sent past the deadline with no bid = expired; Sent with a bid = bid_submitted (stays so after the
deadline, but can't be edited); Accepted = accepted; Not Selected = not_selected; Declined = declined; gig Cancelled = expired.

One accept function (`acceptOffer`) serves the bid screen and the manual PATCH. Under a row lock on the gig: winner Accepted, every other offer still Sent becomes Not Selected,
gig Filled. After commit, `bid_accepted` goes to the winner and `bid_not_selected` to the rest (`{{bidAmount}}` reads "the agreed rate" when there was no bid). A bid edit takes
the same lock, so an accept and an edit never both win. Crew reminders use the same `{{gigLink}}` (the accepted offer's page).
