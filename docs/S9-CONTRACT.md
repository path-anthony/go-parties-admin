# S9 contract: what the storefront needs from Block F2

Written 2026-11-12 with admin Block F2. Everything here is live on the admin API (`https://admin.thegoeventgroup.com`, and the old Railway address). Nothing in this file requires the storefront to change before it keeps working: every change is an added field or a new refusal with a plain sentence in `error`. The list under "What the storefront should build" is what makes the new behaviour visible to customers.

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
- **Converted requests**: staff turning a request into a booking no longer always sends a contract. Over $1,000 or with a crewed item the customer gets the contract link as before. At $1,000 or less with no crew the booking appears in My party at "Held" with "Pay your retainer", and nothing is emailed (see "Open with Block F1" below).

## What the storefront should build

1. On Event details, replace "sends you a proposal" and "within one business day" with the promise built from `responseDays` (tier call) or `requestResponseDays` (public settings).
2. On the "In review" screen, show the same promise and a link to the request in My party.
3. In My party, a "Requests" list from `GET /api/customer/requests` with the four statuses, the items, date, address and setup notes. A `booked` request links to its booking.
4. Phone fields (sign-up, Your details): show the `phone-invalid` sentence under the field, and handle it at the hold.
5. Send `name`, `email` or `phone` with "Talk to us instead" and Ask GO when the customer is signed in or has typed them, with `credentials: "include"`.
6. On the crew gig page, show `setupNotes` when present.
7. Optional: a guest count field at checkout, sent as `guestCount`.

## Open with Block F1 (money), not built here

- A request converted on the policy path (small price, no crew) sends the customer nothing. They only learn of it by opening My party.
- A request converted on the contract path sends the contract link; after signing, nothing sends a way to pay.
