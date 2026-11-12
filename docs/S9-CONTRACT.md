# S9 contract: what the storefront needs from Blocks F2 and F1

Sections 1 to 5 were written 2026-11-12 with admin Block F2. Sections 6 to 9 were added 2026-11-13 with admin Block F1 (the money path). Block F3a (2026-11-14) changed nothing the store calls; it added the pay link switch described in section 6 and one new email, the unpaid hold reminder: a signed-in customer who holds a date on a small rental and does not pay is emailed their pay link 1 and 3 days later. Block F3b (2026-11-15) added what the store's pay screen and portal asked for: policy acceptance on the pay link, the items and the balance due date in the pay link's data, the guest count and the policy state on a customer's bookings, and the outcome of a cancellation request (sections 10 to 13, all additive). Everything here is live on the admin API (`https://admin.thegoeventgroup.com`, and the old Railway address). Nothing in this file requires the storefront to change before it keeps working: every change is an added field or a new refusal with a plain sentence in `error`. The list under "What the storefront should build" is what makes the new behaviour visible to customers.

## 1. Review rules result

An order now goes to staff review only when its total is at or over an amount for its occasion group. Defaults: Wedding $5,000, Corporate $5,000, everything else $10,000. Under the amount the order checks out as normal, whatever the occasion. A $225 rental for a rehearsal dinner is now tier 1 and pays online.

The storefront still never decides this. It keeps reading `tier` from the two calls below.

### `POST /api/bookings/tier`

Request is unchanged. Send `occasion` as soon as the customer picks it (the answer can change from tier 1 or 2 to tier 3 and back as the cart changes).

Tier 3 answer (new field: `responseDays`):

```json
{
  "tier": 3,
  "reasons": ["threshold"],
  "total": 5400,
  "retainerPercent": 20,
  "retainerAmount": 1080,
  "policy": null,
  "contract": null,
  "quoteExpiresAt": null,
  "address": null,
  "responseDays": 3
}
```

- `reasons` is always `["threshold"]` for a review answer now. The old value `"occasion"` is no longer sent. Do not show `reasons` to the customer.
- `responseDays` is how many business days staff promise to make contact within. Use it in the copy: "We will contact you within 3 business days." It replaces the hardcoded "within one business day".
- Tier 1 and tier 2 answers are unchanged and do not carry `responseDays`.

### `POST /api/bookings/direct` when the order goes to review (HTTP 202)

```json
{
  "reviewRequired": true,
  "designRequestId": "cmw...",
  "status": "Open",
  "reasons": ["threshold"],
  "occasion": "Reception only",
  "eventDate": "2026-12-26",
  "total": 5400,
  "responseDays": 3,
  "message": "This one goes to our team first. Nothing is held yet; we'll be in touch to put it together with you."
}
```

New: `responseDays`. Everything the customer gave is now kept on the request: the picked place and full address, the setup pin, the setup notes, the "Same as my home address" tick and the guest count (see section 4). Keep sending the same body as for any hold, including `delivery`.

### `GET /api/settings/public`

One added field, so the promise can be shown before the hold:

```json
{ "requestResponseDays": 3 }
```

## 2. The customer's request list (new)

### `GET /api/customer/requests`

Signed-in customer only (same session cookie as My party; 401 without it). Newest first.

```json
{
  "responseDays": 3,
  "promise": "We will contact you within 3 business days.",
  "requests": [
    {
      "id": "cmw...",
      "status": "received",
      "statusLabel": "Received",
      "bookingId": null,
      "createdAt": "2026-11-12T15:04:11.000Z",
      "eventDate": "2026-12-26",
      "eventTime": "4 PM",
      "occasion": "Reception only",
      "address": "14 Maple Ln, Avon, CT 06001, USA",
      "mapsUrl": "https://www.google.com/maps/search/?api=1&query=41.810200,-72.830900&query_place_id=ChIJ...",
      "setupNotes": "Backyard, gate on the left",
      "guestCount": 120,
      "total": 5400,
      "package": null,
      "items": [{ "name": "Grand Tent", "quantity": 1 }],
      "addons": [{ "itemName": "Grand Tent", "groupName": "Sides", "addonName": "With walls" }],
      "promise": "We will contact you within 3 business days."
    }
  ]
}
```

`status` is one of four values. Show `statusLabel`, or your own words for each:

| `status` | `statusLabel` | Meaning | `bookingId` | `promise` |
|---|---|---|---|---|
| `received` | Received | Sent, nobody at GO has written on it yet | null | the sentence |
| `being-reviewed` | Being reviewed | Staff have started working on it | null | the sentence |
| `booked` | Turned into a booking | Staff made it a booking | the booking id; it is also in `GET /api/customer/bookings` | null |
| `closed` | Closed | Staff closed it. The reason is never sent | null | null |

Staff notes and the reason for closing never leave the server. `total` can be null. `mapsUrl`, `setupNotes`, `guestCount`, `eventTime`, `occasion`, `address` and `package` can each be null.

## 3. The phone error (new refusal)

The store must send a real US phone: ten digits (a leading `1` or `+1` is accepted and dropped), the area code and the exchange not starting with 0 or 1, and not one digit ten times. Punctuation and spaces are fine.

It is checked on:

- `POST /api/customer/signup`
- `PATCH /api/customer/me` (when `phone` is sent)
- `POST /api/bookings/direct` (the phone in the body, or the signed-in account's phone)

Refusal, HTTP 400:

```json
{
  "error": "Enter a 10 digit US phone number, like (860) 555-0142.",
  "reason": "phone-invalid",
  "field": "phone"
}
```

Show `error` in red under the phone field. On a hold from a signed-in customer the bad number is the one on their account: send them to "Your details" in My party to fix it, then let them hold again. Accounts made before this block can hold a number that now fails (for example `2222222222`).

New accounts store the phone as ten digits, and `customer.phone` comes back that way. Sign-in by phone accepts any spelling of the same number.

## 4. Guest count and the rest of the request

`POST /api/bookings/direct` already accepts `guestCount` (a whole number from 1 to 5000, or absent). It is now stored on a review request and carried onto the booking when staff convert it. The store does not ask for a guest count today; when it does, send it with the hold and the tier call:

```json
{ "itemIds": ["..."], "eventDate": "2026-12-26", "occasion": "Reception only", "guestCount": 120 }
```

A count that is not a whole number in range is refused as before: 400 with `reason: "guest-count-invalid"`.

For a review request the admin now keeps, from the same hold body: `delivery.placeId`, `delivery.components`, the address point, `delivery.setupLat` and `setupLng` (the dragged pin), `delivery.setupNotes`, `eventAddressSameAsHome` and `guestCount`.

## 5. Other changes the store can see

- **Crew gig page**, `GET /api/bids/:token`: when the crew member's bid is accepted the response now also has `setupNotes` (the customer's own words, or null), next to `arrivalNotes`.
- **"Talk to us instead"**, `POST /api/leads/concierge`: accepts optional `name`, `email` and `phone`, and uses the signed-in customer's details when the session cookie is sent. A lead is made only when there is at least one of the three. With none, the answer is HTTP 200 `{ "ok": true, "leadId": null }` and the customer should still be sent to Calendly. With one or more it is HTTP 201 `{ "ok": true, "leadId": "..." }` as before.
- **Ask GO**, `POST /api/recommend`: accepts the same optional `name`, `email` and `phone`, and reads the session cookie when sent (`credentials: "include"`). The response is unchanged. A chat with none of the three is not saved as a lead.
- **"We got your request" email and text** now say "a person will contact you within N business days" with the same N.
- **Converted requests**: staff turning a request into a booking no longer always sends a contract. Over $1,000 or with a crewed item the customer gets the contract link as before. At $1,000 or less with no crew the booking appears in My party at "Held" with "Pay your retainer", and since Block F1 the customer is texted and emailed their pay link with the amount (section 6).

## What the storefront should build

1. On Event details, replace "sends you a proposal" and "within one business day" with the promise built from `responseDays` (tier call) or `requestResponseDays` (public settings).
2. On the "In review" screen, show the same promise and a link to the request in My party.
3. In My party, a "Requests" list from `GET /api/customer/requests` with the four statuses, the items, date, address and setup notes. A `booked` request links to its booking.
4. Phone fields (sign-up, Your details): show the `phone-invalid` sentence under the field, and handle it at the hold.
5. Send `name`, `email` or `phone` with "Talk to us instead" and Ask GO when the customer is signed in or has typed them, with `credentials: "include"`.
6. On the crew gig page, show `setupNotes` when present.
7. Optional: a guest count field at checkout, sent as `guestCount`.

# Block F1: the money path

Everything below is live on the admin API. Two things change behaviour the storefront already uses and need a look before the next storefront release: the cancel call (section 7) and the stage of a paid small rental (section 8). The rest is new and additive.

## 6. The pay link

Every booking has one private pay link: `https://admin.thegoeventgroup.com/pay/<token>`. The token is unguessable and belongs to one booking, the same pattern as the contract link, so a customer with no account can use it. The admin sends it by text and email with the dollar amount:

- right after staff turn a request into a booking, or create a booking themselves (policy path: the pay link; contract path: the contract link first, saying the retainer amount);
- right after a contract is signed from a link or from My party with the retainer unpaid;
- as reminders 1, 3 and 7 days after the retainer was first asked for (the days are a setting);
- in every balance reminder, with the amount and the due date;
- whenever staff press "Send pay link" on a booking.

A contract signed at checkout is not sent a link that minute, because the pay step is the next screen. If the customer leaves without paying, the reminders carry the link.

### What the link does today (no storefront work needed)

`GET /pay/<token>` on the admin host looks at what is owed and sends the customer there:

| What is owed | Where the link goes |
|---|---|
| A contract booking, not signed yet | the signing page, `<store>/sign/<signingToken>` (works without an account) |
| The retainer | Stripe's own hosted payment page for the retainer amount |
| The balance (retainer paid) | Stripe's own hosted payment page for the balance |
| Nothing, or the booking is cancelled or finished | a plain page that says so, with a link to My party |

After paying, Stripe returns the customer to `/pay/<token>/done`, a plain admin page: "Payment received. Thank you." with a link to My party. Leaving Stripe without paying lands on `/pay/<token>/back`: "No payment was made", with the link again. These pages are plain on purpose and are not styled like the store.

### What the storefront should build: a pay screen at `<store>/pay/:token`

A store screen would let the customer see the booking, review the rental policy (policy path) and pay in the embedded form they already know from checkout. Since admin Block F3a there is a switch for this: Settings > Integrations > "Pay links open the storefront pay page", off by default. When the screen is deployed the owner turns it on, and every pay link in a new text or email is `<store>/pay/<token>` instead of the admin address. The admin address keeps working, so links already sent are not broken. The route must exist on the store before the switch is turned on. It needs two calls. Neither uses the session cookie.

#### `GET /api/pay/:token`

```json
{
  "step": "retainer",
  "amount": 45,
  "kind": "retainer",
  "stage": "Held",
  "eventDate": "2026-12-26",
  "customerFirstName": "Sarah",
  "total": 225,
  "paid": 0,
  "retainerPaid": false,
  "balancePaid": false,
  "contractLink": null,
  "policy": { "id": "cmw...", "version": 4, "text": "Cancellation and retainer policy ..." },
  "hasAccount": false
}
```

- `step` is one of `sign`, `retainer`, `balance`, `nothing`, `closed`.
  - `sign`: a contract booking that is not signed. `contractLink` is the signing page; send the customer there first. `amount` is the retainer they will owe after signing.
  - `retainer` or `balance`: `amount` is what to collect now, in dollars. Never compute it in the browser.
  - `nothing`: all paid up. `closed`: cancelled, released or finished.
- `policy` is the current rental policy for a booking with no contract (null for a contract booking, or when no policy text exists). Its numbers are already filled in (no `{{tokens}}` to merge); show `text` as it is. Show it above the pay button on the policy path: a booking staff made on the phone was agreed to out loud, and this is where the customer reads it.
- 404 `{ "error": "That pay link isn't known.", "reason": "not-found" }` for a wrong token.
- Nothing else about the booking is returned: no surname, phone, email, address or items.

#### `POST /api/pay/:token/session`

No body. Returns the same shape as `POST /api/customer/bookings/:id/payments/session`, for the embedded Stripe form:

```json
{ "clientSecret": "cs_test_..._secret_...", "sessionId": "cs_test_...", "amount": 45, "kind": "retainer" }
```

Refusals, HTTP 409: `{ "reason": "not-payable", "error": "Sign the contract first, then the retainer." }` and `{ "reason": "nothing-due", "error": "Nothing is due right now." }`. After the form reports completion, poll `GET /api/payments/status?sessionId=...` exactly as checkout does.

## 7. Cancellation requests (changed behaviour)

**A customer can no longer cancel a booking.** `POST /api/customer/bookings/:id/cancel` now asks GO to cancel it. The booking, its date and its items stay exactly as they were until staff approve or decline, and the customer is emailed the outcome. This applies to every booking, including contract bookings, which used to answer `call-go`.

### `GET /api/customer/bookings/:id/cancel` (new)

Call it when the customer opens "Cancel", to know what to show.

```json
{
  "paid": 45,
  "retainerPaid": true,
  "termsRequired": true,
  "terms": {
    "source": "policy",
    "title": "Cancellation and retainer policy",
    "text": "The retainer is 20% of the total and is non-refundable ..."
  },
  "pendingRequest": null
}
```

- `termsRequired` is true when anything has been paid. Show `terms.title` and `terms.text` in full with a checkbox ("I have read and accept these terms") before the customer can send the request.
- `terms.text` is finished wording: the policy's numbers are already filled in, so do not run it through the store's token merge.
- `terms.source` is `contract` when the text comes from the customer's own signed contract (its retainer and cancellation clauses), otherwise `policy` (the rental policy from Settings > Contract and policy). `terms` can be null when no text exists; the customer can still ask.
- `pendingRequest` is set when a request is already waiting: show "We're reviewing your request to cancel" instead of the form.
- 409 with a sentence in `error` for a booking that is already cancelled, released or finished.

### `POST /api/customer/bookings/:id/cancel`

Request:

```json
{ "reason": "We moved the party to another weekend", "acceptTerms": true }
```

- `reason` is optional text, up to 1000 characters. Ask for it; staff read it. Links are stripped.
- `acceptTerms` must be `true` when `termsRequired` was true. The admin records the time and the exact text accepted.

When terms are required and `acceptTerms` is missing, HTTP 409. Nothing is created:

```json
{
  "error": "A retainer has been paid on this booking. Read and accept the retainer terms to ask to cancel, or call or text GO.",
  "reason": "terms-required",
  "paid": 45,
  "terms": { "source": "policy", "title": "Cancellation and retainer policy", "text": "..." }
}
```

**The storefront as deployed today sends no body.** For an unpaid booking its Cancel button still "works", but the booking is not cancelled: it becomes a request. For a paid booking it now gets the 409 above. Update the screen before customers find this.

When the request is made, HTTP 202. The body is the customer booking as `GET /api/customer/bookings` returns it (unchanged, so the screen can redraw from it) plus:

```json
{
  "id": "cmw...",
  "stage": "Confirmed",
  "pendingRequest": { "type": "cancellation", "id": "cmx...", "status": "open", "requestedAt": "2026-11-13T15:04:11.000Z", "reason": "We moved the party to another weekend" },
  "cancellationRequested": true,
  "cancellationRequest": { "id": "cmx...", "status": "open", "requestedAt": "2026-11-13T15:04:11.000Z", "reason": "We moved the party to another weekend", "termsAccepted": true },
  "paid": 45,
  "terms": { "source": "policy", "title": "Cancellation and retainer policy", "text": "..." },
  "message": "We got your request to cancel. Your booking is still in place until our team reviews it, and we will email you with the outcome."
}
```

Asking again while one is open answers HTTP 200 with the same request. A booking already cancelled or released answers 200 with the booking, as before. A finished booking answers 409.

### What the customer sees afterwards

- While staff decide: the booking is unchanged and `pendingRequest` is set on it in `GET /api/customer/bookings`. Show "Cancellation requested, we're reviewing it" and hide Cancel, Reschedule and Change.
- Approved: the booking's `stage` becomes `Cancelled`, `pendingRequest` goes back to null, and the customer gets the "Cancellation approved" email.
- Declined: the booking is unchanged, `pendingRequest` goes back to null, and the customer gets the "Cancellation not approved" email asking them to call.
- The admin never refunds automatically. Do not promise a refund anywhere on this screen.

## 8. Booking states (changed behaviour)

`stage` on a customer booking is one of: `Held`, `Requested`, `Contract Sent`, `Signed`, `Retainer Paid`, `Confirmed`, `Completed`, `Cancelled`, `Released`.

What changed: **a small rental (tier 1, no contract) is now `Confirmed` the moment its retainer is paid.** It used to read `Retainer Paid` and never move on. The customer also gets the "Booking confirmed" text and email, and the calendar invite, at that moment.

| Booking | Before paying | After the retainer is paid |
|---|---|---|
| Tier 1 (rental policy) | `Held` | `Confirmed` (was `Retainer Paid`) |
| Tier 2, signed at checkout | `Requested` | `Confirmed` (unchanged) |
| Tier 2, contract sent by staff | `Requested`, then still `Requested` once signed | `Confirmed` (unchanged) |
| Any, cancelled by staff or an approved request | | `Cancelled` |
| Tier 1 hold that lapsed unpaid | `Released` | |

`Retainer Paid` can still appear, for a contract booking whose retainer staff recorded before the contract was signed. Treat it as "paid, waiting on the signature". A small rental paid before 2026-11-13 can also still read `Retainer Paid`.

A tier 1 booking, as `GET /api/customer/bookings` returns its Block T1 fields after paying:

```json
{
  "tier": 1,
  "stage": "Confirmed",
  "steps": [
    { "key": "retainer", "state": "done", "at": "2026-11-13T15:02:40.000Z" },
    { "key": "balance", "state": "next" }
  ],
  "contract": { "agreementId": "cmw...", "status": "none", "signedAt": null, "pdfUrl": null },
  "retainer": { "amount": 45, "paid": true, "paidAt": "2026-11-13T15:02:40.000Z", "payable": false },
  "balance": { "amount": 180, "dueDate": "2026-11-26", "paid": false, "payable": true },
  "rescheduleMode": "self",
  "pendingRequest": null
}
```

`pendingRequest` was always null before; it is now `{ "type": "cancellation", "id", "status": "open", "requestedAt", "reason" }` while a cancellation request waits.

The store's own promise, "We'll email you a secure payment link", is now kept: balance reminders carry the pay link, the amount and the due date.

## 9. What the storefront should build for Block F1

1. **Cancel becomes "Ask to cancel"** (section 7): call the GET, show the terms with a checkbox when `termsRequired`, ask for a reason, POST with `acceptTerms`, then show the pending state. This one is needed soon: today's Cancel button no longer cancels.
2. **Show `pendingRequest`** on a booking in My party and hide the self-serve actions while it is set.
3. **Treat `Confirmed` as the paid state for small rentals** (section 8). Anything keyed on `Retainer Paid` for tier 1 should also accept `Confirmed`.
4. **A pay screen at `/pay/:token`** (section 6), with the policy shown on the policy path and the embedded Stripe form. Until it exists the admin's plain pages do the job.
5. Optional: on the checkout "pay your retainer" step, say that a reminder with a payment link will follow if they leave.

# Block F3b: what the pay screen and the portal asked for

Four additions, all live on the admin API. Nothing was renamed or removed, and nothing here changes how a payment is taken, how an amount is worked out, or when a booking becomes `Confirmed`.

## 10. Policy acceptance on the pay link (new call)

A booking staff made by phone was agreed to out loud. The pay screen is where the customer reads the rental policy and accepts it themselves. When they tick the box, tell the admin:

### `POST /api/pay/:token/policy`

Request. Send the `id` of the policy the screen showed (from `GET /api/pay/:token`), so a policy saved in between is caught:

```json
{ "accept": true, "policyId": "cmw..." }
```

Recorded, HTTP 201:

```json
{ "policyAccepted": true, "policyAcceptedAt": "2026-11-15T15:04:11.000Z", "policyVersion": 4 }
```

- The admin stores the time, the policy version, and the exact text the customer saw (numbers filled in) on the booking. Staff then read "Policy accepted by customer on November 15, 2026, on the pay page (version 4)."
- The first acceptance stands. Calling again answers HTTP 200 with the same `policyAcceptedAt`; nothing is overwritten. No session cookie is used.
- It does not start a payment. Call `POST /api/pay/:token/session` afterwards as before. The admin does not refuse a payment because the box was not ticked: the store's screen is what requires the tick before showing the pay form.

Refusals:

| HTTP | `reason` | When |
|---|---|---|
| 400 | `accept-required` | `accept` was not `true`. Nothing is recorded. |
| 404 | `not-found` | The token is not known. |
| 409 | `policy-changed` | `policyId` is not the current policy. The body carries the current one as `policy: { id, version, text }`: show it and ask again. |
| 409 | `not-needed` | A contract booking. The contract is the agreement; there is no policy to accept. |
| 409 | `closed` | The booking is cancelled, released or finished. |
| 409 | `no-policy` | No policy text exists yet. |

```json
{ "error": "The policy was updated. Please read it again.", "reason": "policy-changed", "policy": { "id": "cmx...", "version": 5, "text": "Cancellation and retainer policy ..." } }
```

## 11. The pay link's data: policy state, items, balance due date

`GET /api/pay/:token` keeps every field in section 6 and adds the ones marked new:

```json
{
  "step": "retainer",
  "amount": 90,
  "kind": "retainer",
  "stage": "Held",
  "eventDate": "2026-12-26",
  "customerFirstName": "Sarah",
  "total": 450,
  "paid": 0,
  "retainerPaid": false,
  "balancePaid": false,
  "contractLink": null,
  "policy": { "id": "cmw...", "version": 4, "text": "Cancellation and retainer policy ..." },
  "hasAccount": false,

  "policyRequired": true,
  "policyAccepted": false,
  "policyAcceptedAt": null,
  "eventTime": "2 PM",
  "guestCount": 80,
  "package": null,
  "items": [
    { "name": "Portable Bar", "quantity": 2 },
    { "name": "Bartender", "quantity": 1 }
  ],
  "balance": 360,
  "balanceDueDate": "2026-12-12"
}
```

- `policyRequired` is false on a contract booking (and `policy` is null). When it is true and `policyAccepted` is false, show `policy.text` with the checkbox and call section 10 before the pay form.
- `policyAccepted` is true when the customer has accepted the policy themselves: on this pay screen, or with the checkbox at checkout in the store. A staff "customer agreed" tick does not count. `policyAcceptedAt` is the time, or null.
- Once accepted on the pay link, `policy` is the text and version they accepted, even if a newer policy has been saved since.
- `items` are the booking's lines, a name and a count. A service with crew (no physical unit) is a line too. `package` is the package name when the booking is a package, else null; `items` is still filled.
- `balance` is what is left after the retainer, in dollars (null when nothing is priced). `balanceDueDate` is `YYYY-MM-DD`, the event date less the balance due days setting (null when nothing is priced).
- `eventTime` and `guestCount` can be null. Still no surname, phone, email or address.

## 12. A customer's bookings: guest count and policy

Each booking in `GET /api/customer/bookings` (and every response that returns a customer booking) now also has:

```json
{
  "id": "cmw...",
  "tier": 1,
  "stage": "Held",
  "guestCount": 80,
  "policyRequired": true,
  "policyAccepted": true,
  "policyAcceptedAt": "2026-11-13T15:02:40.000Z"
}
```

- `guestCount` is a whole number or null.
- `policyRequired`, `policyAccepted` and `policyAcceptedAt` mean the same as in section 11. A booking the customer made in the store with the box ticked is `policyAccepted: true` from the start. A booking staff made for them is false until they accept on the pay link.

## 13. A customer's bookings: the outcome of a cancellation request

Each customer booking now carries `cancellation`: the newest request to cancel and what became of it. It is null when the customer never asked. The store no longer has to remember on the device that a request was sent.

Waiting on staff:

```json
{
  "id": "cmw...",
  "stage": "Confirmed",
  "pendingRequest": { "type": "cancellation", "id": "cmx...", "status": "open", "requestedAt": "2026-11-13T15:04:11.000Z", "reason": "We moved the party" },
  "cancellation": { "id": "cmx...", "status": "waiting", "requestedAt": "2026-11-13T15:04:11.000Z", "decidedAt": null, "reason": "We moved the party" }
}
```

Declined (the booking is unchanged):

```json
{
  "stage": "Confirmed",
  "pendingRequest": null,
  "cancellation": { "id": "cmx...", "status": "declined", "requestedAt": "2026-11-13T15:04:11.000Z", "decidedAt": "2026-11-14T14:30:00.000Z", "reason": "We moved the party" }
}
```

Approved (the booking is cancelled):

```json
{
  "stage": "Cancelled",
  "pendingRequest": null,
  "cancellation": { "id": "cmx...", "status": "approved", "requestedAt": "2026-11-13T15:04:11.000Z", "decidedAt": "2026-11-14T14:30:00.000Z", "reason": "We moved the party" }
}
```

- `status` is `waiting`, `approved` or `declined`. `decidedAt` is null while waiting.
- `reason` is the customer's own words. Staff notes on the decision never leave the server.
- When the customer asks again after a decline, `cancellation` is the new request (`waiting`).
- `pendingRequest` is unchanged from section 8 and is still set only while a request waits.

## 14. What the storefront should build for Block F3b

1. On the pay screen, when `policyRequired` is true and `policyAccepted` is false: show `policy.text` with a checkbox, call `POST /api/pay/:token/policy` with `policyId` when it is ticked, then show the pay form. On `policy-changed`, show the new text and ask again.
2. On the pay screen, show `items` (or `package`), `eventTime`, `guestCount`, and the balance with `balanceDueDate`.
3. In My party, show `guestCount`, and "Policy accepted" from `policyAccepted`.
4. In My party, show the cancellation outcome from `cancellation.status` and its dates, and drop the device memory of a sent request.
