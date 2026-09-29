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

Reminders: `POST /api/automations/check-reminders` (header `x-webhook-secret`) `{ windowDays?: 0-120, dryRun?: boolean }`
returns `{ windowDays, dryRun, today, due, reminders: [{ bookingId, customerName, eventDate, balance, balancePaymentPreference, result }] }`.

## Merge fields in the policy text

`{{customer_name}} {{event_date}} {{event_time}} {{event_address}} {{total}} {{deposit_percentage}} {{deposit_amount}} {{balance_amount}} {{cancellation_window_days}}`,
also in camelCase. `deposit_percentage` is a bare number (write the % yourself). Unknown fields are left as typed.
