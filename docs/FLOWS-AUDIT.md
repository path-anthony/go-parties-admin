# Purchase path audit (Block AUDIT1)

Read only. Written 2026-11-11 from the code on admin `main` (`18d399d` plus the A12 merge `4cad560`) and storefront `main` (`24b86e2`), and from SELECT queries against the production database. Nothing was changed. File references are `file:line` in the admin repo unless they start with `store:` (the storefront repo). Anything I could not confirm is marked **not verified**.

Words used here: **retainer** is the up-front payment that holds the date. **Tier 1** is a small rental that only needs the policy checkbox. **Tier 2** is a booking that needs the GO contract. **Tier 3** is a booking that goes to staff review first (it lands in Design requests). **The bell** is the notification bell in the admin. **The digest** is the 7 AM Eastern email of unread bell alerts.

## Changed since this audit: Block F2 (2026-11-12)

The audit below was written on 2026-11-11. Block F2 changed the parts listed here. Where a later section still describes the old behaviour it carries a note "Changed in F2". Money, holds and booking stages were not touched (that is Block F1).

| What | Before | Now |
|---|---|---|
| Review rule | Any Wedding or Corporate occasion went to staff review at any price; everything else at over $15,000 | An amount per occasion group: Wedding $5,000, Corporate $5,000, Kids party, Adult party and no occasion $10,000 (`server/review.ts`, Settings > Booking rules > Review rules). At the amount counts. Under it the order checks out as normal |
| The rule in code | `review.ts:40-41`, `tiers.ts:35` | `reviewDecision` in `server/review.ts`: `if (input.total !== null && input.total >= line.amount)`. The occasion the customer picked and the package's occasions both count, and the lower amount applies |
| Reason shown to staff | "Occasion needs review" | The exact rule, for example "Wedding total is $5,000 or more" (`design_requests.review_reason`) |
| A $225 rehearsal dinner | Design request, nothing to pay | Tier 1: holds the date and pays the retainer online. It still gets the wedding details form |
| What a request keeps | Items, address text, contact | Also the place id, the address point, the dragged setup pin, setup notes, the "same as home" tick and the guest count. Shown on the request card |
| Convert | Always a contract (tier 2) | The normal rule: over $1,000 or a crewed item is the contract path and the contract link is sent; $1,000 or less with no crew is the policy path and **nothing is sent** (left for Block F1). Everything on the request is carried onto the booking |
| Dismiss | Silent | Needs a reason; "Tell the customer by email" sends the editable "Request closed" email. The reason never goes to the customer |
| Bell alert for a request | Stayed after convert or dismiss | Cleared (marked read) on both |
| Requests left open | Sat forever | After N business days (Settings, default 3) a "Request still waiting" bell alert is raised every day until handled, so it is in each 7 AM digest |
| The customer's view | Nothing in My party | `GET /api/customer/requests` lists their requests with a plain status and the promise "We will contact you within N business days" (the store page is in `docs/S9-CONTRACT.md`) |
| Phone | Any 7 to 15 digits | The store must send a real US number (400 `phone-invalid`). Staff entry is not checked |
| Ask GO and "Talk to us instead" leads | Always made, with no contact | Made only with a name, an email or a phone. Ask GO leads with contact now ring the bell |
| Occasion | Not on the booking popup or list | Shown on both |
| Setup notes on crew pages | Never | Sent to the crew member whose bid was accepted |
| "We got your request" message | "Big events get a personal look. We'll reach out within one business day." | "A person will contact you within N business days." |

Gaps closed: 2, 4, 5 (the pin and notes part), 7, 8 and 10 (the forced contract; the silent block when the GO contract is switched on is unchanged). Gaps 1, 3, 6 and 9 are Block F1.

## Changed since this audit: Block F1 (2026-11-13)

Block F1 is the money path. It closes gaps 1, 3, 6 and 9 and changes 13 and 25. How the retainer and the balance are calculated did not change. The app still never charges a card on its own, and since F1 it has no way to send money out at all (the Stripe refund button and call were removed).

| What | Before | Now |
|---|---|---|
| A paid small rental (tier 1) | Stayed at Held, read "Retainer Paid" forever, reminders paused by the storefront hold | Confirmed the moment the retainer is paid, on every path (card, a payment staff record, or the Retainer paid tick). The moment is stored in `bookings.confirmed_at` (`server/confirm.ts`). The customer gets "Booking confirmed" and the calendar invite. Event, balance and wedding details reminders run |
| A contract booking (tier 2) | Confirmed when Signed and paid | Unchanged: it needs both the signature and the retainer |
| Paying without an account | Not possible | Every booking has a private pay link, `<admin>/pay/<token>` (`server/payLink.ts`, `server/routes/pay.ts`). It goes to what is owed: the contract to sign, then Stripe's hosted page for the retainer, then for the balance |
| After staff convert a request or create a booking | Contract path: contract link, no amount. Policy path: nothing | Policy path: text and email with the retainer amount and the pay link. Contract path: the contract link with the retainer amount ("Contract ready to sign, with the retainer amount"). New booking has a tick box, on by default; conversion always sends |
| After a contract is signed with the retainer unpaid | The signed copy, and nothing about paying | The signed copy, then the pay link with the amount. Signed at checkout: nothing that minute (the pay step is the next screen); reminders follow |
| Retainer reminders | None | 1, 3 and 7 days after the first ask (Settings > Booking rules > Retainer reminders), by text and email with the link, at 10 AM. They stop when paid or cancelled. The day after the last one: bell alert "Retainer still unpaid" |
| Balance reminder | "Please call or text us to arrange payment" | The real balance, the due date and the pay link. The store's promise "We'll email you a secure payment link" is now kept |
| Send by hand | Only "Send contract link" | "Send pay link" on the booking popup: shows the amount first, sends whichever is owed, shows when it last went and who sent it |
| Customer cancels in My party | Tier 1: cancelled at once, units freed, staff not told. Tier 2 and 3: "Call or text GO" | Every tier: a cancellation request with a reason. With a retainer paid the customer is shown the retainer terms and must accept them, and what they accepted is stored. Nothing is cancelled or freed until staff decide |
| Staff and a cancellation | Found out from the lead's activity | Bell alert "Cancellation request", a digest line, the lead tagged "Cancellation request" with the booking, contact details, what was paid and the reason. Approve cancels, frees the units and emails the customer; Decline keeps the booking and emails the customer. Both emails are editable templates |
| Refunds | Owner pressed Refund and the app asked Stripe to send the money | The app never asks Stripe for a refund. Staff refund in Stripe and write it in the refund log on the booking (amount, date, method, note). The log is a record only. Stripe's own "refunded" notice still updates the payment row |
| Staff told when money arrives | No | Bell alert "Payment received" for every payment (card or recorded by hand), in the next digest. Overview has "Money in" (last 7 days, with a total) and "Waiting on payment" (unpaid retainers, balances due within 14 days or late) |
| The same Stripe event twice | One payment, but the webhook and the status check could both run the after-payment steps | One conditional update decides who records it; the other does nothing |

Gaps closed: 1, 3, 6, 9. Gap 13 (the cancellation window is printed, not enforced): a customer can no longer cancel alone, so staff now decide every case with the terms the customer accepted in front of them. Gap 25: a cancellation is now tied to a decision and to a refund log, and the refund itself is made in Stripe.

Still open after F1: the pay link and the after-payment page are plain pages on the admin address until the storefront builds its own (`docs/S9-CONTRACT.md` section 6); the storefront's Cancel button needs the new screen (section 7); gap 16 (a lead is "Booked" at the hold, before anything is paid); gap 18 (unpaid holds never release while both settings are 0); gap 20 (the two old placeholder tiles on Overview).

## Part 6. One page summary (read this first)

| # | Path | Who it is for | Stripe | Staff action needed | Where in admin |
|---|---|---|---|---|---|
| 1 | Self-serve policy checkout (tier 1) | Customer. Total $1,000 or less, no crewed item, no Wedding or Corporate occasion | Yes, on the "Your retainer" screen right after "Hold my date". Retainer is 20% of the total today. Customer can skip it ("Pay later") | None required. Nothing moves the booking forward after payment (see gap 1) | Scheduling > Bookings. Leads board, column "Booked". Bell: "New lead" |
| 2 | Contract checkout (tier 2) | Customer. Total over $1,000, or any item that needs crew | Yes, on the "Your retainer" screen after the customer signs the contract in checkout. Amount comes from the quote | None required. Staff get a text and email "contract signed" | Scheduling > Bookings. Leads board. Bell: "New lead" |
| 3 | Staff review request (tier 3). Changed in F2 | Customer. Total at or over the review amount for the occasion: Wedding or Corporate $5,000, everything else $10,000 | No. The customer is told "Nothing to pay yet" | Yes. Open the request, then Convert to booking or Dismiss (with a reason) | Design requests (Open filter). Bell: "Request for review", then "Request still waiting" daily after 3 business days. Not in Leads, not in Scheduling |
| 4 | Convert a design request (staff). Changed in F2 | Staff | None at conversion. Contract path: customer signs in My party, then pays the retainer there. Policy path: customer pays the retainer in My party, nothing is sent | Tick "customer agreed", click Create booking from this request | Scheduling > Bookings, at Contract Sent (contract path) or Held (policy path). Request moves to the Converted filter |
| 5 | Package, fixed price | Customer, from Home. Same rules as 1 to 3, and the package's own occasions count toward review | As path 1, 2 or 3 | As path 1, 2 or 3 | Packages & Themes (setup). Bookings as above. No packages are published in production today |
| 6 | Package, price per guest | Nobody can book one today. The store never asks for a guest count | n/a | n/a | Packages & Themes |
| 7 | Ask GO ("Build my party"). Changed in F2 | Customer chatting | None until they send the cart to checkout (then path 1, 2 or 3) | Follow up when a lead appears. A chat with no name, email or phone makes no lead | Leads, source "ask-go", column New. Bell: "New lead" |
| 8 | "Ask about this" (price on request) | Customer, item with no price (57 visible items) | None | None. Same lead as Ask GO | Leads, source "ask-go" |
| 9 | "Talk to us instead" (concierge) | Customer at checkout or in Ask GO | None | Watch for the Calendly booking; the lead carries no contact | Leads, source "concierge". Bell: "New lead" |
| 10 | Website form | Visitor on the marketing site, through n8n | None | Call or text the lead back | Leads, source "website". Bell: "New lead" |
| 11 | Staff-created booking | Staff, on the phone | None at creation. Customer pays from My party (if they have an account), or staff record the payment | Send the contract link if one is needed, record payments | Scheduling > Bookings > New booking |
| 12 | Staff-entered lead | Staff | None | Follow up by hand | Leads > Add lead. No bell alert |
| 13 | After the sale: pay balance, reschedule, change item, cancel | Customer in My party | Yes for the balance (card, in My party). Nothing is emailed with a link | Record cash or check payments by hand. Refunds by hand | Scheduling > Bookings > booking popup > Payments |

## Part 0. Settings in force in production today

These decide almost every route below. Read from the `accounts` row on 2026-11-11.

| Setting (where it is in Settings) | Value today | What it decides |
|---|---|---|
| Review rules (changed in F2) | Wedding 5000, Corporate 5000, Kids party 10000, Adult party 10000, everything else 10000 | An order at or over the amount for its occasion goes to Design requests. The old occasion list and the $15,000 line are kept in the database and no longer read |
| Contact the customer within (business days) | 3 | The promise shown to a customer in review, and when a waiting request starts raising a daily alert |
| Contract required over ($) | 1000 | Total above this needs the GO contract (tier 2) |
| Contract required for crewed items | On | Any DJ, MC or other crewed item needs the contract |
| Retainer (% of total) | 20 | Retainer on tier 1 and on a staff-converted booking |
| Small rentals pay at checkout | The retainer | Tier 1 pays the retainer, not the full amount |
| Balance due (days before the event) | 30 | Printed in contracts and the portal |
| Free cancellation window (days) | 30 | Printed in the policy and contracts. Not enforced by code (see gap 13) |
| Require an account to book | Off | The store still always asks for an account (store:ItemAccount.tsx has no guest path) |
| Require the rental policy checkbox | Off | A hold without the ticked box still goes through |
| Use the GO contract for new bookings | Off | New contracts use the older layout (policy text), not the three-page GO contract |
| Unpaid holds released after (days), both kinds | 0 and 0 | Nothing is ever released automatically |
| Short-notice window (hours) | 72 | A booking sooner than this is marked RUSH |
| Balance reminder window (days) | 7 | Customer balance reminders and the "Balance due soon" bell alert |
| Staff alert phone and email | Set (email goes to the owner's address) | Where "contract signed" and "crew question" go |
| Daily digest | On, goes to the info mailbox | 7 AM Eastern, only if something is unread |
| Message wording overrides | None. Every message uses the built-in wording | Texts are on for every message. Emails are on only for the ones marked on by default |

Production facts that matter below: 1 account, 426 items (5 hidden, 58 with no price), 455 units, **0 packages**, 17 customers, 7 design requests ever (5 converted, 2 still Open), 104 leads, 68 messages logged.

## Part 1. Every path from cart to close

### How every storefront checkout starts (shared by paths 1 to 5)

1. The customer picks items (Browse), a package (Home), or sends an Ask GO party to checkout. Any item with no price shows "Ask about this" instead of "Add" (store:Browse.tsx:120, :285), so it cannot reach checkout from the store.
2. Options (only if an item has add-on groups), then the date and time, then "Sign in or create an account". An account is always required on the store: there is no guest button (store:ItemAccount.tsx:25). Sign-up asks name, email, phone, password and home address.
3. **Event details** (store:ItemWho.tsx). The customer sees: When, the cart, "Booking as" (name, phone, email), **"What are you celebrating?"** (required), "Your home address" (only if the account has none), "Same as my home address", **Event address**, a map with a draggable setup pin, **Setup notes** (optional, 200 characters), a line saying what happens next, the policy checkbox (not shown for tier 2), and a button.
4. As soon as this screen opens the store asks the admin which tier applies (`POST /api/bookings/tier`, `server/routes/tier.ts`). The line under the form comes from that answer (store:CheckoutNotes.tsx:42):
   - Tier 1: "Your retainer is next. Paying it holds the date." Button "Hold my date".
   - Tier 2: "This booking comes with a contract. You'll read and sign it on the next screen, then pay the retainer." Button "Next".
   - Tier 3: "Nothing to pay yet. GO reviews this one first and sends you a proposal." Button "Hold my date".
5. A picked address is also checked with Google. A town, a street with no number or a non-US address is refused with "We couldn't find that exact address. Pick it from the suggestions, or check the street number." (`server/routes/tier.ts:65`, hold in `server/routes/directBookings.ts`).

### The rule that picks the path (exact code)

The admin decides the path itself. The store only reads the answer, and the hold recomputes it and refuses a mismatch with `tier-changed` (`server/directBooking.ts:304` onward).

```
review.ts:40   if (input.total !== null && input.total > input.fullReviewThreshold) reasons.push("threshold");
review.ts:41   if (input.occasions.some((o) => occasionNeedsReview(o, input.reviewOccasions)) || (input.categories ?? []).some(... categoryNeedsReview ...)) reasons.push("occasion");
tiers.ts:35    if (review.length > 0) return { tier: 3, reasons: review };
tiers.ts:38    if (input.total !== null && input.total > rules.contractRequiredOver) reasons.push("over-contract-threshold");
tiers.ts:39    if (rules.contractRequiredForCrewed && input.crewed) reasons.push("crewed");
tiers.ts:40    if (reasons.length > 0) return { tier: 2, reasons };
tiers.ts:41    return { tier: 1, reasons: [] };
```

In plain words, in this order: review rules first (tier 3), then the contract rules (tier 2), otherwise tier 1. "Exactly at the threshold does not count" for both dollar rules.

What counts as "the occasion" is wider than the dropdown. At the hold, `server/directBooking.ts:224-226` uses all three of: the occasion the customer picked, the occasions the package is sold for, and the item categories in the cart. An occasion is on the review list if it is listed itself **or belongs to a listed group** (`server/review.ts:10-15`): with the list "Wedding, Corporate", every sub-occasion of those two groups goes to review. An item category counts if it contains the word Wedding or Corporate (`server/review.ts:21-28`); no category in production does today.

### Path 1. Self-serve policy checkout (tier 1)

- **Conditions.** No review reason (not a Wedding or Corporate occasion, total at or under $15,000), total at or under $1,000 (`tiers.ts:38`), and no item needs crew (`tiers.ts:39`). Total can also be empty (an item with no price), which lands here because `input.total !== null` guards both dollar rules.
- **Customer sees.** Event details, then "Hold my date". Then **"Your retainer"**: "Your 20% retainer holds the date. It is non-refundable." with the amount (20% of the total today) and Stripe's embedded card form (store:ItemPay.tsx). Two exits: pay, which shows "Paid. Your date is held."; or "Pay later", which shows **"Held. You're good."** ("Your retainer is still due; pay it any time from My party."). If the event is inside 72 hours the last screen reads "Pending. We'll be in touch." instead (RUSH). Last thing seen: the Held or Paid screen, then "Done" returns to Home.
- **Stripe.** Yes. `createPaymentSession(booking, "retainer")` runs right after the booking is made (`server/directBooking.ts:545`), storefront bookings only. Amount: `total x 20 / 100` (`server/tiers.ts:45`). If Stripe is not set up the customer sees "To be confirmed" and no card form.
- **Records created** (one transaction, `server/directBooking.ts:375-490`): a Lead (source "storefront", placed in the column named "Booked", line 395), a Booking (status Held, tier 1, occasion, address, place id, point, setup pin and setup notes, mailing address from the verified address), one BookingUnit per item (the unit is locked and held), add-on rows, an Agreement row (policy version, checkbox state, IP hash), crew gigs for any crewed item, and, when the customer paid, a Payment row. The home address is saved on the customer account (`server/routes/directBookings.ts`).
- **In admin.** Scheduling > Bookings (popup shows "Tier 1: rental policy", RUSH tag if short notice, Delivery section with the setup notes, Payments section). Leads board column "Booked". Customers have no screen in the admin.
- **Messages.** Bell: "New lead" (`server/directBooking.ts:559`). Customer: **nothing at hold time**. When the retainer is paid by card, the stage becomes Retainer Paid and the customer gets "Retainer received" (text on, email on by default; `server/notify.ts:35-40`, `server/payments.ts:194`). No text or email goes to staff when a payment lands.
- **What staff must do.** Nothing is required. Optional: open the booking and check the address, setup notes and the "address verified" chip. To move the stage: Bookings > booking > Stage menu. Setting Stage to Signed sends "Signed contract on file" (text) even though no contract exists.
- **If staff does nothing.** The booking stays "Held" and, once the retainer is paid, "Retainer Paid". It never becomes "Confirmed" (that needs Stage = Signed, `src/lib/bookingStatus.ts:24`) and no automatic reminders go out (gap 1). Unpaid holds are never released because the release settings are 0 and 0.

### Path 2. Contract checkout (tier 2)

- **Conditions.** No review reason, and total over $1,000 (`tiers.ts:38`) or any crewed item (`tiers.ts:39`).
- **Customer sees.** Event details with "Next" instead of "Hold my date", then **"Your contract"**: the full GO contract built from their cart, a signature box and consent, button "Sign contract" (store:ItemContract.tsx). The contract is a quote that is good until the end of the day it was made; if it changes or expires the customer is sent back. Then "Your retainer" (as in path 1) and the last screen **"Signed. Your date is requested."** ("is yours once the retainer is paid") or, after paying, **"Signed and paid. Your date is confirmed."**
- **Stripe.** Yes, same screen as path 1, after the signature. Amount is the retainer printed in the signed quote (`server/payments.ts:56-70`). The retainer link will not open until the contract is signed (`server/payments.ts:105`: "Sign the contract first, then the retainer").
- **Records.** As path 1, plus a Quote row, the signed contract document and PDF, and the agreement marked Signed (booking stage Signed).
- **In admin.** Same places, popup chip "Tier 2: contract", Contract section with the signed PDF.
- **Messages.** Customer: signed copy by text and email ("contract_signed"). Staff: text to the staff phone and email to the staff address ("staff_contract_signed"). Bell: "New lead". Paying afterwards moves the stage to Confirmed and the customer gets "Booking confirmed". No staff alert on payment.
- **Staff must do.** Nothing required. If the booking has a crewed item, open Crew & Gigs and invite crew (see "Crewed items" below).
- **If staff does nothing.** The customer has signed and not paid: the planner sends the customer a nudge 48 hours after the link went out only if still unsigned, so a signed-unpaid customer gets no reminder. The bell shows "Retainer unpaid" 3 days after signing (`server/notifications.ts`). The held units stay held. With both release settings at 0 they are never released.

### Path 3. Staff review request (tier 3)

**Changed in F2:** the condition is now the amount per occasion group, the request keeps everything the customer typed, the customer can see it, and a waiting request raises a daily alert. See the table at the top.

- **Conditions.** `reviewReasons` returns anything (`server/directBooking.ts:219-228`): total over $15,000, or any occasion, package occasion or item category on the review list. Today: any Wedding or Corporate sub-occasion, "Wedding" or "Corporate" (what the store sends for "Other wedding" and "Other corporate").
- **Customer sees.** The same Event details screen, with the line "Nothing to pay yet. GO reviews this one first and sends you a proposal." They press "Hold my date". The last screen is **"In review"**: "Our team takes it from here. Big events get a personal look. We'll reach out within one business day." and "Nothing is held and nothing is charged. We'll reach out by phone or email." (store:ItemReview.tsx:26-33). The checkbox for the rental policy is shown and recorded. **My party shows nothing for this request**: it lists bookings only, and the "In review" and "Proposal ready" stage wording in the store is never sent by the admin (it exists only in the store's mock data).
- **Stripe.** No.
- **Records created.** A DesignRequest (`server/directBooking.ts:232-262`) with status Open, the reason list, occasion, date, time, address text, name, phone, email, customer id, package, total, balance preference and a `cart` JSON (items, quantities, add-ons, package, computed total). An Agreement row for the request records the checkbox. **No Lead, no Booking, no BookingUnit. Nothing is locked.** The setup pin, setup notes, place id, home address and same-as-home answer are not stored (Part 3).
- **In admin.** Design requests, filter Open (default). The card shows the name, date and time, total, occasion, a pill ("Over the review threshold" and or "Occasion needs review"), phone, email, received date, the items, the package, the typed address, and a staff notes box. There is no count badge on the sidebar and no card on Overview.
- **Messages.** Customer: text and email "We got your request" (`server/notify.ts:189`; email wording: "Big events get a personal look. We'll reach out within one business day."). Staff: bell **"Big event request"** only, with a link to Design requests, Open (`server/notifications.ts:104-121`). No text or email to staff. The 7 AM digest lists it if still unread.
- **Staff must do.** Click by click: bell (or sidebar) > Design requests > find the card > read it > optionally type staff notes and Save notes > **Convert to booking** (path 4) or **Dismiss**.
- **If staff does nothing.** The request stays Open forever. No reminder, no aging flag, no escalation. Production proof: two requests from 2026-09-29 are still Open with event dates of 2026-10-14 and 2026-11-06, both already past. The customer was promised contact within one business day.

### Path 4. Converting a design request (staff)

**Changed in F2:** the booking is no longer forced to a contract, and the pin, setup notes, exact place, "same as home" tick and guest count are carried onto it. See the table at the top.

- **Conditions.** Staff click **Convert to booking** on an Open request. The route refuses a request that is not Open (`server/routes/directBookings.ts:398`) and a date in the past.
- **Staff sees.** The "Convert design request" window opens pre-filled from the request (date, time, address text, occasion, items and quantities, options, contact, price, balance preference). Staff can change anything, including the price. They must tick **"The customer has agreed to the cancellation and retainer policy."** (`src/components/NewBookingModal.tsx:195`) and click **"Create booking from this request"**.
- **What the server does** (`server/directBooking.ts`): skips the review rules ("A request being converted by staff has already been reviewed", line 219); forces the tier to at least 2 (`line 304: designRequestId ? (decided.tier === 3 ? 2 : decided.tier)`), so **every converted request gets a contract, even a $225 rental**; locks one free unit per item for the date (line 375; if none is free staff see "That date was just booked by someone else"); creates the Lead (source "manual", column "Booked"), Booking, BookingUnits, Agreement; marks the request Converted and links it (line 505); then calls `sendContract(..., "conversion")` (line 513).
- **Stripe.** Not at conversion. `createPaymentSession` is skipped for staff bookings (line 545).
- **What the customer receives right away** (`server/notify.ts:63-120`). A "Your GO! Event Group contract is ready" email and a text with the same link. A customer with an account gets `/party/<booking id>/contract` (My party, signed in); anyone else gets the `/sign/<token>` page (`contractReadyLink`, `server/notify.ts:165`). Because "Use the GO contract" is off in production, this is the older layout (policy text, typed name, two checkboxes), not the three-page GO contract. The booking stage moves from Held to **Contract Sent**. The nudge "Your contract still needs a signature" follows 48 hours later if unsigned (email on by default).
- **What the customer does next.** Opens the link, signs (My party, "Sign contract"). The page then says "Signed. Thank you. Your contract is signed and on file. The retainer is the next step." with a single button **Back to My party**. In My party the step list shows "Pay your retainer", which opens the Stripe form (store:PartyPay.tsx). The amount is 20% of the total. Guests without an account who signed on the `/sign` page see "Nothing more to do here" and are never offered payment (store:Sign.tsx:81).
- **Staff sees after.** The banner says "Turned X's request into a Held booking. It is in Scheduling." (`src/components/screens/DesignRequestsScreen.tsx:196`), but the booking is at Contract Sent, not Held. The request moves to the Converted filter. In Scheduling > Bookings the booking shows "Tier 2: contract".
- **Later messages.** Staff get a text and email when the customer signs. The customer gets the signed copy. Paying moves the booking to Confirmed and the customer gets "Booking confirmed". Reminders (event week, eve, thanks, balance) work, because the lead source is "manual" and the storefront-hold pause does not apply.
- **If the customer never signs.** The bell shows "Needs a push to sign" at 3 days; the customer gets the 48-hour nudge once. The unit stays held. The hold-release rule only touches bookings whose lead source is "storefront" (`server/holds.ts:31`), so a converted booking is never released automatically, whatever the settings.

### Path 4b. Dismissing a design request

**Changed in F2:** dismissing asks for a reason, can email the customer, and clears the bell alert.

Click **Dismiss** on the card. The server only sets the status to Dismissed (`server/routes/designRequests.ts:46-56`). Nothing is sent to the customer. No unit changes (none was held). The bell alert for the request is not cleared. The card moves to the Dismissed filter, where **Reopen** puts it back to Open. There is no reason field and no way to tell the customer from this screen. The store's My party never showed the request, so the customer is left with only the "within one business day" promise.

### Path 5. Packages with a fixed price

A package is a published bundle in Packages & Themes. On Home the customer taps a package; its items go to the cart with the bundle price (store:Home.tsx:130-155). Checkout is identical to paths 1 to 3. Differences: the package price replaces the item prices (`server/packagePricing.ts`), the hold refuses a cart that does not match the package ("The items don't match the package"), and the package's occasions are added to the review check (`server/directBooking.ts:226`), so a package sold for Wedding always goes to staff review. **Production has no packages**, so Home shows none today. Block P1 (twelve draft packages) has not been applied.

### Path 6. Packages priced per guest

Admin side is built (base price plus price per guest, with a minimum and maximum). The store has no code for it: no guest count field, no mention of per-guest pricing anywhere in the storefront source. The hold would refuse with "Tell us how many guests, so we can price this package." (`server/packagePricing.ts:13`). Staff can book one in the admin (New booking asks for a guest count). Nothing is published today, so this is latent.

### Path 7. Ask GO ("Build my party")

- **Customer sees.** Home > "Tell GO about your party" box > Ask GO chat. Answers are written by the AI. When the party is ready they see a list of items and a total with **"Book these"** (store:Ask.tsx:333). That button puts the priced items in the cart and starts the checkout above (path 1, 2 or 3). Items with no price are listed but are not sent to checkout.
- **Stripe.** None in the chat.
- **Records.** When the AI commits to a party (`ready: true`), a Lead is written: source "ask-go", column "New", with the theme, items and total. **It has no name or contact** (`server/routes/recommend.ts:40`). Production: 27 of 27 Ask GO leads have none.
- **In admin.** Leads board, column New, source ask-go. **No bell alert** (`server/notifications.ts` skips these on purpose).
- **Messages.** None to the customer. None to staff.
- **Staff must do.** Nothing can be done with these leads: there is nobody to call.
- **If staff does nothing.** The lead sits in New. A public daily cap (150 messages) stops the chat when reached.

### Path 8. "Ask about this" (price on request)

On Browse an item with no price shows **"Ask about this"** instead of Add (store:Browse.tsx:120, :285). It opens Ask GO with a prefilled question. From there it is path 7. Production has 57 visible items with no price. The admin API itself would accept a booking for one (the guard is only in the store), which I did not test (**not verified**).

### Path 9. "Talk to us instead" (concierge)

A quiet link under the "Hold my date" button on Event details and in Ask GO (store:CheckoutConcierge.tsx). It sends the occasion, what the customer was looking at and the date to `POST /api/leads/concierge`, then opens Calendly (30 minute call) in the browser. A Lead is created with source "concierge", tags "concierge" and "from checkout" or "from Ask GO", and a note ("Name and contact come with the Calendly booking."). Bell: "New lead". Stripe: none. Customer message: none from this system (Calendly sends its own). Production: 9 of 9 concierge leads have no contact, so staff match them to Calendly by hand. The trigger "Concierge call booked" is registered but not wired (`server/triggers.ts:135`).

### Path 10. Website form (n8n)

The marketing site's form goes through n8n to `POST /api/leads/external` with a shared secret (`server/routes/externalLeads.ts`). A Lead is created: source "website", column "New", name, contact, occasion, notes. Bell: "New lead". No Stripe. No message from this system (the website's own automation replies; **not verified**). Production: 13 website leads, 8 still in New.

### Path 11. Staff-created booking (Scheduling > Bookings > New booking)

- **Staff does.** Fills the form: customer (search an existing account or type name, phone, email), items and quantities, date, time, address, occasion, balance preference, optional price override, ticks "The customer has agreed to the cancellation and retainer policy", **Create booking**. The same unit locks, crew checks and add-on rules apply as on the store.
- **Rule.** If the cart or occasion is a review case and the request is not a conversion, the result is a Design request instead of a booking ("This one needs review, so it was sent to Design requests instead of being held. Nothing is locked yet." `src/components/NewBookingModal.tsx:229`). The address text is checked with Google after the save and never refused.
- **Records.** Lead (source "manual", column "Booked"), Booking (status Held, tier from the rules), units, agreement (checkbox ticked by staff), no setup pin or notes.
- **Stripe.** None at creation (`server/directBooking.ts:545` is storefront only). The customer can pay the retainer from My party if the booking is attached to an account. A tier 2 booking needs the contract signed first.
- **Messages.** None automatically. Staff open the booking popup and press **Send contract link** (Contract section) when a contract is needed; that texts and emails the link and moves Held to Contract Sent. Stage changes after that text the customer automatically (Signed, Retainer Paid, Confirmed, Cancelled).
- **If staff does nothing.** The booking sits at Held. It holds the units. Because the lead is "manual" no storefront pause applies, so reminders run once the retainer is paid.
- **Warning.** If someone turns on "Use the GO contract", Send contract link refuses until the venue, on-site contact, guest count and from and to times are filled in (`server/notify.ts:79-102`). The refusal is logged only as a "skipped-not-ready" text row in Messages > Sent log. There is no bell alert and the customer receives nothing. Off today.

### Path 12. Staff-entered lead (Leads > Add lead)

A Lead with source "manual" and whatever staff type. No bell. If it has a phone or email, "Follow up, day 3" and "Follow up, day 10" go out (text on, email off by default; texts only 9 AM to 8 PM Eastern and never on Sundays, `server/sendRules.ts`). Website and storefront leads never get these (`server/triggers.ts:109-122`).

### Path 13. After the sale (My party)

| Action | Who can | Rule | What happens |
|---|---|---|---|
| Sign the contract | Tier 2 and 3 customer | My party step "Sign" | Stage Signed. Customer gets the signed copy. Staff get a text and email |
| Pay the retainer | Anyone with a retainer due | Tier 2 only after signing (`server/payments.ts:105`) | Stripe form. Stage becomes Retainer Paid or Confirmed. Customer gets a message. Staff get nothing |
| Pay the balance | After the retainer is paid | `server/payments.ts:101-110` | Same Stripe form in My party. **No email or text carries this link** (gap 3) |
| Reschedule, change item, cancel | **Tier 1 customers only** | `server/portal.ts:133` (`selfServeAllowed`). Tier 2 and 3 see "Call or text GO to change this booking." | Cancel releases the units and crew gigs, logs it on the lead and updates the calendar. **No message to the customer, no alert to staff, no refund, no check of the 30 day window** (`server/routes/customer.ts:255-270`, `server/bookingOps.ts:56-67`) |
| Wedding details form | Customer, wedding bookings | Due 30 days before the event | See Part 3, wedding row |

Money recorded by staff: Booking popup > Payments > **Record a payment** (cash, check, other) and **Refund**. There is no "send a payment link" button. Staff payments also trigger the stage message to the customer (`server/payments.ts:199-220`).

### Crewed items (any path)

An item that needs crew (a DJ, MC, photographer) creates one Gig per skill at hold time; if nobody with that skill is free that day the customer is told "Nobody on the crew is free to cover the ... for that date. Try another date." and nothing is held. Staff then invite crew from Crew & Gigs. Customers never see crew steps. A crewed item forces tier 2 (`tiers.ts:39`).

### Rush

A booking made less than 72 hours before the event is marked RUSH (tag and banner in the booking popup, Scheduling and Overview). It does not change the path. The store's last screen says "Pending. We'll be in touch." and shows the company phone.

## Part 2. The test you ran on 2026-11-11

**Changed in F2:** the same order today is tier 1. A $225 Rehearsal dinner holds the date and is offered the retainer online, and still gets the wedding details form. The account of what happened on Nov 11 below is unchanged.

The record (production database, read only): customer **anthony+fridgetest**, one **6 ft Portable Bar** (category "Bar and Cigar", price $225.00), occasion **Rehearsal dinner**, Fri Nov 20 2026 at 2:30 PM, 110 N 3rd St, Columbus, OH 43215. Phone typed as 2222222222. Times below are Eastern.

### What the database shows happened

| Time | What | Evidence |
|---|---|---|
| 3:35 PM | The account was created, with a home address in Pickerington, OH saved on it | `customers` row, `home_address`, `home_place_id` set |
| 3:37 PM | The store sent the hold. The admin answered "review" and made a **design request**: status Open, reason list `{occasion}` only, total $225.00, balance preference "Reminder link". The Agreement row for the request has the policy checkbox ticked | `design_requests` row; `agreements` row with `design_request_id` |
| 3:37 PM | Bell alert "Big event request: TEST, Fri, Nov 20. Rehearsal dinner. $225." | `notifications` |
| 3:37 PM | Customer got the "We got your request" **email** (sent). The same message by **text failed**: Twilio 400, code 21211, invalid phone number | `message_logs` |
| 3:39 PM | **Someone clicked Convert to booking.** The request is now Converted and linked to a booking. See "What Convert did" below | `design_requests.status = Converted`, `booking_id` set |

So the answers about Convert are both the rule and what actually happened to this record.

### Why you were never asked to pay

Because the admin decided this was a **tier 3 review case before any payment step exists**. The rule, in the order the code applies it:

1. The store sent occasion = "Rehearsal dinner" (`store:src/lib/directInput.ts:22-25`, it sends the sub-occasion name when there is one).
2. In production the review list is **Wedding, Corporate** (`accounts.review_occasions`).
3. `server/review.ts:10-15`: an occasion needs review "if it is listed itself or belongs to a listed group". "Rehearsal dinner" is one of the five sub-occasions of the **Wedding** group (`src/lib/occasions.ts:9-10`), so `occasionNeedsReview("Rehearsal dinner", ["Wedding","Corporate"])` is true.
4. `server/review.ts:41` pushes the reason `occasion`. `server/tiers.ts:35`: "if (review.length > 0) return { tier: 3 ...}". Price does not matter: the $225 total is far below the $15,000 threshold, which is why only `occasion` is in the reason list and not `threshold`.
5. At the hold, `server/directBooking.ts:219-228` finds a reason, so it creates a DesignRequest and returns the review answer (`server/directBooking.ts:291`: "This one goes to our team first. Nothing is held yet; we'll be in touch to put it together with you.") **before** the code that makes a booking, locks a unit or asks Stripe for a payment (`server/directBooking.ts:545`).
6. The store had already told you on the Event details screen: "Nothing to pay yet. GO reviews this one first and sends you a proposal." (`store:CheckoutNotes.tsx:45`) and ended on "In review. Our team takes it from here ... Nothing is held and nothing is charged."

Nothing about the item, the price or the date mattered. Any occasion in the Wedding or Corporate groups does this (Part 4).

### Is the unit held for that date?

**No, not while it was a request.** A design request creates no BookingUnit and takes no lock (`server/directBooking.ts:219-228`; the Design requests page says "Nothing is locked on a request"). Another customer could have booked the 6 ft Portable Bar for Nov 20 in the meantime. The database confirms it: the request had no `booking_units` rows.

**It is held now,** because the request was converted: `booking_units` has one row for the booking, **Unit #1** of the 6 ft Portable Bar, event date Nov 20, created at 3:39 PM.

### What "Occasion needs review" means

It is the label on the pill (`src/components/screens/DesignRequestsScreen.tsx:11`: `occasion: "Occasion needs review"`). It means one of three things matched the review list in Settings > Booking rules > Staff review: the occasion the customer picked, an occasion the chosen package is sold for, or a word in an item's category. It says nothing about size or price. The other pill, "Over the review threshold", is separate and means the total was above $15,000. Both pills can show together.

### What exactly happens when staff click Convert to booking

Observed on your record, and matching the code (Path 4 in Part 1):

1. A "Convert design request" window opens, pre-filled. Staff tick "The customer has agreed to the cancellation and retainer policy" and click **Create booking from this request**.
2. The server makes a **booking at tier 2**, not tier 1 (`server/directBooking.ts:304`: a converted request is forced to at least tier 2). So a $225 rental becomes a contract booking. The booking row has `tier = 2`.
3. It holds **Unit #1** for Nov 20, makes a **lead** (source "manual", sitting in the column "Booked", still unsigned and unpaid) and an **agreement**, and marks the request Converted.
4. It re-checks the address with Google after saving: this record came back verified, with the Google place id and point (`address_check = verified`). The booking has **no setup pin and no setup notes** (they were never stored, see Part 3).
5. **Is a contract sent? Yes, immediately.** The agreement was marked Sent at 3:39:31 PM and the booking moved to stage **Contract Sent**. Because "Use the GO contract" is off, it is the older layout (policy text, typed name, two checkboxes), not the three-page GO contract.
6. **Is a pay link sent? No.** No Stripe session was created (`payments` has no rows for this booking). The contract email contains only the contract link. The customer has an account, so the link goes to **My party > contract** (`/party/<id>/contract`), not to a payment page.
7. **Does the customer get an email? Yes**: "Your GO! Event Group contract is ready: Hi TEST, Your contract for Fri, Nov 20 is ready to review and sign: (link)". The same text message **failed** again because of the invalid phone number. Staff would see the failure only in Messages > Sent log; nothing alerts them.
8. **How does the retainer get paid?** The customer signs in My party. The contract page then says "The retainer is the next step" and offers only "Back to My party". In My party the step list shows "Pay your retainer"; that opens a Stripe card form for **20% of $225 = $45.00** (`server/payments.ts:56-70`, `server/tiers.ts:45`). Until the contract is signed the server refuses to open it: "Sign the contract first, then the retainer." (`server/payments.ts:105`). No email carries a payment link at any point. If the customer never opens My party, the retainer is never paid and nothing prompts them after the signed-copy email. Staff can also click Booking > Payments > **Record a payment** if the customer pays by cash or check.
9. After the customer signs, staff get a text (the staff phone is set) and an email, and a "Needs a push to sign" bell alert is raised if the contract is still unsigned 3 days after it was sent. The customer gets a nudge email 48 hours after the link if still unsigned.
10. Also triggered by the occasion: **Rehearsal dinner counts as a wedding** (`server/weddingDetails/logic.ts:16`), so the booking gets the wedding details questionnaire (202 fields), the "Wedding details" panel on the booking popup, and wedding bell alerts ("not started" at 60 days out, "incomplete" at 35). The event is 9 days away, so these are due at the next hourly run (**not yet observed**: no wedding alerts existed at the time of the query). The customer reminder emails for the questionnaire are switched off. Staff can switch the wedding flag off in the booking popup.

One small thing on screen: after Convert the banner says "Turned TEST's request into a **Held** booking" but the booking is **Contract Sent**.

### What happens on Dismiss

`server/routes/designRequests.ts:46-56`: the status becomes Dismissed and that is all. No message to the customer, no change to units (none were held), the bell alert stays, nothing is logged on any lead (there is no lead). The card appears under the Dismissed filter, where **Reopen** puts it back to Open. A dismissed request can no longer be converted until it is reopened (`server/routes/directBookings.ts:398`). The customer is never told. Their My party shows nothing either way.

Not verified: whether the contract link in the email works end to end for your test account (I did not open it, and the agreement shows it was not signed).

## Part 3. Lost fields

### Setup notes, traced end to end

1. **Typed** on Event details, store:`ItemWho.tsx:385-391`. The box (placeholder "Backyard, gate on the left", 200 characters, "Optional. Where the crew should set up, in a line.") **only appears when the address was picked from Google's suggestions and verified** (`pick && b.verified`). A typed address with no pick gets no box.
2. **Kept in the browser** as `setupNotes` in the booking store (store:`state/booking.tsx:85`). It is cleared if the address pick is dropped (store:`ItemWho.tsx:104`, `:134`).
3. **Sent** inside the `delivery` object of `POST /api/bookings/direct` (store:`directInput.ts:62-66`: `setupNotes: b.setupNotes.trim()`).
4. **Cleaned** by `parseDelivery` (`server/delivery.ts:53-55`, up to 500 characters).
5. **The fork.** The route hands `delivery` to `createDirectBooking`. What happens next depends on the path:
   - **Tier 1 or 2 (a booking is made):** stored in `bookings.setup_notes` (`server/directBooking.ts:434`, `server/delivery.ts:165-175`). Saved.
   - **Tier 3 (a design request is made):** the design-request branch (`server/directBooking.ts:219-293`) never reads `delivery`. The request row has no column for it and its `cart` JSON holds only items, add-ons, package and computed total. **Not saved.**
6. **On Convert** the pre-filled window carries date, time, address text, occasion, items, contact, price and balance preference. It has no setup notes or pin to carry, and the staff booking route passes no `delivery` (`server/routes/directBookings.ts:410-433`). **Still not saved.**

**For your test record: not saved, and cannot be recovered.** The request row has no such column, the `cart` JSON has none, and the converted booking's `setup_notes` is empty. I cannot see what your browser sent (**not verified**), but no code path stores setup notes for a review request, so the answer is the same either way.

Where setup notes show when they **are** saved (tier 1 or 2 booking):

- Booking popup > **Delivery** section > "Setup notes" (editable), `src/components/DeliverySection.tsx:61`.
- The internal Google Calendar event description, "Setup notes: ..." (`server/google/payload.ts:98`). Not in the customer's invite.
- The customer's My party booking card, "Setup: ..." (store:`MyParty.tsx:159`), and the confirmation screen right after the hold (store:`ItemHeld.tsx:34`, shown from the browser's memory, not from the server).

Where they **never** show: the design request card, the crew bid and gig pages (crew only see `arrivalNotes`, a separate field staff type per gig, `server/bids.ts:109`), the booking list, any text or email (no merge token exists for them), the contract, and any print view (the only print view is the wedding form).

### The table

"Test" means your Rehearsal dinner record. "Booking path" means a tier 1 or tier 2 booking made on the store.

| Field | Saved? | Shown where | Missing where |
|---|---|---|---|
| **Setup notes** | Booking path: yes (`bookings.setup_notes`). Review request and Convert: **no**. Test record: **no** | Booking popup > Delivery. Internal calendar event. Customer My party card and the post-hold screen | Design request card. Crew bid and gig pages. Customer invite event. All texts and emails. Contract. Print views. The Convert window |
| **Dragged setup pin** | Booking path: yes (`bookings.setup_lat`, `setup_lng`). Review request and Convert: **no**. Test record: **no**, only the address point (found by Google) is on the booking | Booking popup > Delivery: map centered on the pin, editable latitude and longitude, "Setup pin in Maps" button (`DeliverySection.tsx:16-17`, `:66`). Customer My party mini map (store:`MyParty.tsx:105-124`) | Crew bid and gig pages and the calendar events: since Block A9 their map link opens the **exact place** at the address point, not the pin, whenever Google found the address (`server/delivery.ts:187-192`). Design request card. Convert window |
| **Home address** | Yes, on the customer account (`customers.home_address` plus place id and point), saved at sign-up or with the first hold. Test: yes, "3077 Highland Park Dr, Pickerington, OH" | The customer's own My party "Your details". Copied to the booking when "Same as my home address" is ticked | **Nowhere in the admin**: there is no Customers screen and the booking popup shows only the event address. The "same as home" tick is stored on bookings (`event_address_same_as_home`) and shown nowhere. A design request stores neither the home address nor the tick |
| **Phone** | Yes. Account (digits only, 7 to 15), copied to every lead, booking and design request. Test: saved as 2222222222 | Design request card. Booking popup (editable). Lead card. Internal calendar event ("Customer: name phone"). Messages > Sent log (recipient) | Crew pages (on purpose). The customer invite. No check that the number works: the test number made every text fail (Twilio 21211), visible only in Sent log |
| **Guest count** | **Not asked by the store.** `bookings.guest_count` is filled only for per-guest packages by staff. `expected_guests` and the gig guest count are typed by staff. Test: none | Contract Details > "Expected guests" (required for the GO contract) and the GO contract itself. Crew bid page "Event" line (gig guest count). Staff Bids panel | Store checkout. Design request card. Booking popup main fields. Any message |
| **Occasion** | Yes. Review request and booking both store the sub-occasion (store sends the group name for "Other ..."). Test: "Rehearsal dinner" | Design request card. Contract "Type of event". Calendar event title (for example "Smith - Sweet 16"). Gig event type prefill. The `{{eventType}}` message token. Wedding panel ("Automatic: yes") | **Booking popup and the Scheduling list show no occasion field.** Lead card shows the item names, not the occasion, for storefront holds |
| **Wedding override** | Staff only, `bookings.wedding_override` (empty means automatic). The customer is never asked. Not on a design request | Booking popup > Wedding details > "Is this a wedding?" (Automatic, Yes, No). Its effects show in the wedding panel, My party's wedding row, the wedding bell alerts and the Scheduling filter "Wedding details missing, event within 45 days" | The Scheduling list and Leads (no wedding badge). Design request card. Nothing tells staff that a Rehearsal dinner, Bridal shower or Engagement party is being treated as a wedding unless they open the panel |

### Other things the store collects and the admin loses or hides

- The policy checkbox is stored on the request's agreement row, but the Convert window makes staff tick "the customer agreed" again.
- The balance preference is always "Reminder link" from the store (`store:directInput.ts:95`), but no code sends a reminder link (gap 3).
- A design request does not record that the customer picked "Same as my home address", their home place, their pin or their notes.

## Part 4. Occasions

**Changed in F2:** no option sends an order to review by itself any more. The occasion only picks which amount applies: Wedding and Corporate options $5,000, Kids party and Adult party options $10,000. The table below is the old behaviour.

The select "What are you celebrating?" is required on Event details (store:`ItemWho.tsx:321-340`). Its list is `SUB_OCC` in `store:src/data/catalog.ts:30-35`, and the admin keeps a copy (`src/lib/occasions.ts:5-13`). With review list **Wedding, Corporate** (production today):

| Group in the select | Option | What the store sends | Path it triggers |
|---|---|---|---|
| Kids party | Birthday | "Birthday" | Tier 1, or tier 2 if over $1,000 or crewed |
| Kids party | Bar/Bat Mitzvah | "Bar/Bat Mitzvah" | Same |
| Kids party | Sweet 16 | "Sweet 16" | Same |
| Kids party | Baby shower | "Baby shower" | Same |
| Kids party | Graduation | "Graduation" | Same |
| Kids party | Other kids party | "Kids party" | Same |
| Adult party | Birthday | "Birthday" (same word as the Kids one, the admin cannot tell them apart) | Same |
| Adult party | Bachelor/Bachelorette | "Bachelor/Bachelorette" | Same |
| Adult party | Anniversary | "Anniversary" | Same |
| Adult party | Retirement | "Retirement" | Same |
| Adult party | Housewarming | "Housewarming" | Same |
| Adult party | Other adult party | "Adult party" | Same |
| **Wedding** | **Ceremony + reception** | "Ceremony + reception" | **Tier 3, staff review, whatever the price** |
| **Wedding** | **Reception only** | "Reception only" | **Tier 3** |
| **Wedding** | **Engagement party** | "Engagement party" | **Tier 3** |
| **Wedding** | **Rehearsal dinner** | "Rehearsal dinner" | **Tier 3** (your test) |
| **Wedding** | **Bridal shower** | "Bridal shower" | **Tier 3** |
| **Wedding** | **Other wedding** | "Wedding" | **Tier 3** |
| **Corporate** | **Holiday party** | "Holiday party" | **Tier 3** |
| **Corporate** | **Team building** | "Team building" | **Tier 3** |
| **Corporate** | **Product launch** | "Product launch" | **Tier 3** |
| **Corporate** | **Client appreciation** | "Client appreciation" | **Tier 3** |
| **Corporate** | **Grand opening** | "Grand opening" | **Tier 3** |
| **Corporate** | **Other corporate** | "Corporate" | **Tier 3** |

**12 of the 24 options go to staff review, at any price.** The ones that send small, simple rentals there: every Wedding option other than a full "Ceremony + reception" is usually a small event (rehearsal dinner, bridal shower, engagement party, reception only), and every Corporate option can be a small rental (a $60 table for a team lunch). The rule looks only at the occasion word, never at the size of the order, so a one-item $225 rental with a Wedding or Corporate occasion takes the same path as a $20,000 wedding. The admin's New booking window warns about it in one line ("Wedding and Corporate, and anything over the threshold, are sent to Design requests"); the store does not.

Other things that matter:

- **Birthday exists in two groups.** The review list can name a group ("Kids party") or a single sub-occasion, but a listed "Birthday" would catch both groups.
- **A package's own occasions count.** A package sold for Wedding always reviews, even if the customer picks Birthday (`server/directBooking.ts:226`).
- **Staff can narrow the rule** in Settings > Booking rules > Staff review by ticking single sub-occasions instead of the whole group, for example leaving Wedding unticked and ticking only "Ceremony + reception". The page lets them. That is a setting change, not a code change.
- **The wedding questionnaire follows the same group:** all five Wedding sub-occasions count as a wedding (`server/weddingDetails/logic.ts:16`), including Rehearsal dinner and Bridal shower.

## Part 5. Gaps, ranked

Findings only. Ranked by how likely they are to cost a sale, lose money or leave someone stuck. Each says what happens, the evidence, and who is affected.

### The top 10

1. (Fixed in F1.) **A paid tier 1 booking never reaches "Confirmed" and gets no automatic reminders.** Tier 1 has no contract, so the stage stays Held. "Confirmed" needs Signed plus paid (`src/lib/bookingStatus.ts:24`) and nothing moves a tier 1 booking to Signed. The booking is also treated as a "storefront hold" because its lead came from the store, its stage is Held and no contract is signed (`server/automation/loaders.ts:180`); the planner then stops the event-week, event-eve, balance and wedding reminders with the reason "Storefront hold: nothing is sent automatically while a storefront booking is Held and unsigned." (`server/automation/planner.ts:298`, `:347`, balance and wedding series use the same flag). The customer's My party says "Retainer received, thank you. Signing your contract confirms the date." (store:`stage.ts`, "Retainer Paid") when there is no contract to sign. Evidence: the only paid tier 1 booking in production (event Nov 24) is at stage Held, retainer paid. Its first customer reminder would be due Nov 17; I could not see future sends, so the missing reminder is **verified in code, not yet observed**. Affects every small self-serve booking.
2. (Fixed in F2.) **The Wedding and Corporate rule sends small rentals to staff review.** 12 of the 24 occasion options trigger it at any price (Part 4). The customer is told "Big events get a personal look" for a $225 bar. They are not asked to pay, nothing is held, and staff must convert by hand. Evidence: your test, and 4 of the 7 requests ever made involved the occasion rule (one together with the price rule, three alone). Affects every customer who picks a Wedding or Corporate option, and the date can be taken by someone else while the request waits.
3. (Fixed in F1.) **The balance link the store promises is never sent.** The store says "Your balance of $X is due 30 days before your event. We'll email you a secure payment link." (store:`CheckoutNotes.tsx:37`). No code emails a balance payment link; the balance reminder text says "Please call or text us to arrange payment." and has no link (`server/triggers.ts:326`). The only way to pay online is the customer opening My party and tapping "Pay balance". Staff have no "send payment link" button, only "Record a payment". The stored preference "Reminder link" is recorded and never acted on. Affects every booking with a balance. Not verified: whether Stripe itself emails receipts.
4. (Fixed in F2.) **Design requests can sit forever and staff are only told through the bell.** The staff alert is a bell entry and the next 7 AM digest (`server/notifications.ts:104-121`). No text or email to staff, no count on the sidebar or Overview, no aging, no reminder. Evidence: two requests from Sept 29 are still Open and their event dates (Oct 14, Nov 6) have passed. A request with a past date cannot be converted until staff change the date in the Convert window (the date check refuses a past day). The customer was promised contact within one business day.
5. (Fixed in F2 for requests and crew pages; the crew and calendar map link still opens the exact place, not the pin.) **Setup notes and the dragged pin are thrown away on every review request.** The hold stores them only when it makes a booking. Convert cannot bring them back. Your typed notes are gone (Part 3). Even on normal bookings the crew pages and calendar events no longer open the pin: since A9 the link points at the exact place first (`server/delivery.ts:187-192`), and the crew only ever see arrival notes that staff type.
6. (Fixed in F1.) **After a converted request is signed, the customer is not given a way to pay.** The contract page ends with "The retainer is the next step" and one button, "Back to My party". The signed-copy message ("Thanks for signing. Your signed contract ... Keep it for your records.") does not mention the retainer and carries only the PDF link; the wording that does mention the retainer ("The next step is the retainer payment") is only sent when staff set the stage to Signed by hand. No retainer reminder exists at all (the only contract reminder is the 48-hour unsigned nudge, `server/automation/planner.ts:300`). A customer who signs and then closes the tab owes a retainer nobody asks for. Guests without an account (staff-made bookings only) see "Nothing more to do here" on the signing page (store:`Sign.tsx:81`) and are never offered payment.
7. (Fixed in F2.) **Ask GO and concierge leads cannot be worked.** 27 of 27 Ask GO leads and 9 of 9 concierge leads in production have no name or contact. They sit in column New. Ask GO leads raise no bell alert. The store's cart is lost when the customer leaves (the registered "cart left behind" messages are not wired, `server/triggers.ts:67-90`).
8. (Fixed in F2.) **The customer cannot see their review request, and a dismissal is silent.** My party lists bookings only; the "In review" and "Proposal ready" stage text in the store is never sent by the admin. Dismiss sends nothing and leaves the bell alert. The checkout line promises "sends you a proposal", but there is no proposal document or step in the admin: the real next step is a contract link.
9. (Fixed in F1.) **Staff are not told when money arrives or when a customer cancels.** A card payment moves the stage and messages the customer but raises no bell, text or email for staff (`server/payments.ts:182-196`). A customer cancel or reschedule in My party (tier 1) releases the units and crew gigs and logs it on the lead, with no message to the customer, no staff alert, no refund path and no check of the 30 day free-cancellation window (`server/routes/customer.ts:255-270`). The customer can cancel after paying the "non-refundable" retainer.
10. (The forced contract is fixed in F2. The silent block is unchanged.) **A converted request is forced to a contract, and the contract can be blocked silently.** Every conversion is tier 2 (`server/directBooking.ts:304`), even a $225 rental. If "Use the GO contract" is switched on, the send refuses until venue, on-site contact, guest count and from and to times are filled in (`server/notify.ts:79-102`). That refusal is a "skipped-not-ready" row in Messages > Sent log only. No alert, nothing to the customer, the booking sits in Held with a unit locked. Off today, but it is the next setting someone will turn on.

### More findings

11. **Fake or wrong phone numbers pass and fail silently.** Sign-up accepts any 7 to 15 digits. Your test number made the design request text and the contract text fail (Twilio 21211). Staff see it only in Sent log. The email still goes, so the customer is reached, but a customer with only a bad phone and no email would not be.
12. **No service area.** Nothing stops a booking 700 miles away: a Columbus, Ohio address was accepted and verified. I found no distance, radius or travel fee rule in either repo. The store only biases address suggestions toward Farmington, CT. Business may handle this by phone; **not verified**.
13. (Changed in F1: customers ask to cancel and staff decide.) **The free cancellation window is printed, not enforced.** 30 days appears in the policy text and contract wording. Tier 1 customers can cancel from My party at any time (see 9). Tier 2 and 3 are told to call.
14. **Per-guest packages cannot be booked from the store,** and **no packages are published at all** (production has 0). The store has no guest count field and never reads per-guest pricing. Home shows no packages today. Block P1 is dry-run only.
15. **Rehearsal dinner, Bridal shower and Engagement party are treated as weddings** by the wedding questionnaire: 202-field form, bell alerts, and a Scheduling filter. Staff must flip the override per booking. The booking popup shows no occasion, so staff may not know why a rehearsal dinner shows "Wedding details".
16. **Lead column "Booked" is set at the moment of the hold,** before anything is paid or signed, for storefront and staff bookings alike (`server/availability.ts:74-80`). The board counts them as won and stops follow-ups. All 47 storefront leads in production are in Booked, including the 23 whose bookings were later cancelled (cancelling does not move the lead).
17. **Duplicate leads.** New booking and Convert each make a new "manual" lead, even if the customer already has a lead (for example a website or concierge lead). Staff can link one by hand.
18. **Unpaid holds never release.** Both release settings are 0 in production. Even if set, converted and staff-made bookings are never released (`server/holds.ts:31` only looks at storefront leads), and a customer's tier 1 booking that paid the retainer is never touched.
19. **Convert banner says "Held"** when the booking is at Contract Sent, and staff must tick "customer agreed to the policy" again although the request already holds the customer's own tick (`src/components/screens/DesignRequestsScreen.tsx:196`, `src/components/NewBookingModal.tsx:195`).
20. **Overview has placeholder tiles** that say "Waiting on payment integration" and "Waiting on the e-sign integration" (`src/components/screens/OverviewScreen.tsx:15-18`) while Stripe and e-signing are live. There is no Design requests tile.
21. **The tier line on Event details sits at the bottom of the form,** below setup notes and the hidden field, and flips after the customer picks an occasion. A customer who does not scroll may not see "Nothing to pay yet" before pressing "Hold my date".
22. **Price on request items.** 57 visible items have no price. The store blocks them, the API does not (not tested). They would hold with a total of nothing and no retainer.
23. **A booking made inside 72 hours is "pending"** for the customer, but the store still takes and shows the retainer screen first for tier 1 and 2 (**not verified** which comes first on screen).
24. **Calendar and customer map links ignore the setup pin; the My party map shows it** (store:`MyParty.tsx:105-124` map uses the pin, the link beside it uses the exact place). The two can point at different spots in the same card.
25. (Changed in F1: refunds are made in Stripe and written in a refund log; the app's own refund call is gone.) **The refund path is manual only.** Refunds are recorded and sent to Stripe from Booking > Payments > Refund. Nothing in the customer flow connects a cancellation to a refund decision.

## Part 7. Not verified

- What the store actually sent for your test (browser network request). Only the stored result is known.
- Whether the contract link in your test email works end to end; I did not open it.
- Replies from the website's own automation to website leads (outside this repo).
- Whether Stripe sends its own payment receipts to customers (a Stripe dashboard setting).
- What the customer sees on the screen order for a RUSH tier 1 or 2 booking.
- Whether the admin API accepts a booking for an unpriced item when called directly.
- Future behavior marked "not yet observed" above (wedding alerts for the test booking, the Nov 17 reminder for the one paid tier 1 booking).
- Anything in n8n, Twilio, Stripe or Google dashboards. This audit reads code and the database only.

## Appendix A. Every automatic message, who gets it and the defaults in production

No message wording has been customised, so these are the built-in defaults (`server/triggers.ts`). Texts are on for every wired message. Emails are on only where marked. A text goes only if the customer's phone works; reminder and follow-up texts wait for 9 AM to 8 PM Eastern (`server/sendRules.ts`).

| Message | When | To | Text | Email |
|---|---|---|---|---|
| Design request received | Right after a review request | Customer | On | On |
| Contract ready to sign | Contract sent (convert, stage Contract Sent, or the Send contract link button) | Customer | On | On |
| Contract still unsigned | 48 hours after the link, if unsigned | Customer | On | On |
| Contract signed, here is your copy | Customer signs | Customer | On | On |
| Staff heads-up: contract signed | Customer signs | Staff phone and email | On | On |
| Signed contract on file | Staff set the stage to Signed | Customer | On | Off |
| Retainer received | Retainer paid (card or recorded) | Customer | On | On |
| Booking confirmed | Signed and paid, whichever is last | Customer | On | On |
| Booking cancelled | Staff cancel | Customer | On | Off |
| Balance due soon | Retainer paid, balance open, inside the reminder window, every 3 days | Customer | On | On |
| Event is a week away, Event is tomorrow, Thanks after the event | 7 days, 1 day before, 1 day after | Customer | On | On |
| Wedding details: not started or not submitted | 60 and 35 days before | Customer | Never sent | Off |
| Follow up, day 3 and day 10 | Leads staff typed in by hand | Lead | On | Off |
| Gig offered, bid accepted, bid not selected, crew reminders | Staff invite or pick crew | Crew | On | Off |
| Crew question | Accepted crew member asks a question | Staff | On | On |
| Staff daily digest | 7 AM Eastern, if unread alerts | Digest email | n/a | On |
| New lead acknowledgement, cart left behind (1 hour, 24 hours), hold about to expire, concierge call booked | Registered, **not wired** | n/a | n/a | n/a |

## Appendix B. Every bell alert

| Alert | Raised when |
|---|---|
| New leads | Website form, concierge click, storefront hold (tier 1 or 2). Not Ask GO, not staff-made |
| Big event requests | A review request is created (storefront or staff) |
| Needs a push to sign | Contract unsigned 3 days after it was sent |
| Retainer unpaid | Signed 3 days ago, retainer not paid |
| Balance due soon | A balance falls due inside the balance reminder window, or is overdue |
| Wedding details not started, incomplete, submitted, change requested | 60 and 35 days out, and when the customer acts |
| Upsell: content creation | Customer answers yes or maybe in the wedding form |
| Address checks paused, Address not checked | 500 Google lookups reached, or a staff booking's address was not exact |

No alert exists for: a payment received, a customer cancel, reschedule or item change, a failed text, a message that could not be sent, a request waiting too long, or an Ask GO lead.
