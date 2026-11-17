# Bug audit: the client's nine reports (2026-11-17)

Read only. No code, setting or record was changed. Sources: the admin repo at main `71ba3cd`, the storefront repo at main `fc2fecf`, SELECT-only queries against production, and the client's screenshots (1A, 1B, 2 to 11) and their "Ask GO FAQ and Policies" document (Nov 15). The screenshots were not committed: four of them show the client's own name, email, phone and home address. Nothing in this file copies them.

"Reproduced" below means one of: seen in a client screenshot and traced to the exact line of code; confirmed in production data; or checked by running the same logic. Where none of those applies the item says "not verified".

## Summary

| # | Problem | Reproduced | Cause in one line | Repo | Size | Risk | Kind | Fix order |
|---|---|---|---|---|---|---|---|---|
| 1 | Per-guest items count as one guest | Yes (screenshots 1B, 8; code; 24 per-guest items in production) | No step anywhere multiplies a per-guest item by the guest count; every per-guest item also has only one unit | Both | Large | High: prices, retainer, contract, holds | Bug | 2 |
| 2 | 20 or more items cannot be held | Yes (screenshot 9 shows the exact refusal) | The hold and the tier call refuse more than 10 items; Ask GO may build 20 | Admin | Small | Low | Bug | 1 |
| 3 | Ask GO changes the cart without being asked | Yes (code) | Every "ready" reply carries a fresh item list and the store replaces the cart with it; the model never sees the cart | Both | Medium | Medium: what a customer books | Bug | 3 |
| 4 | Cart does not persist | Yes (code) | Two separate in-memory carts, the header counts one, Ask GO's joins only on "Book this party" and replaces the other; nothing is saved across a page load | Storefront | Medium | Medium: a lost cart is a lost sale | Bug | 4 |
| 5 | Wrong occasion on the lead | Yes (production: two leads in the same minute, one says graduation, one "Team building") | The store keeps one occasion for the whole visit, set by an earlier checkout or package, never cleared, and sends it with Ask GO and "Talk to us" | Storefront (admin stores what it is sent) | Small | Low | Bug | 5 |
| 6 | Clicking an item card does nothing | Yes (code) | There is no item detail view; only the Add button acts | Storefront | Medium to large | Low | Missing feature (working as built) | 9 |
| 7 | Contract date cannot be filled in | Yes (screenshot 4; code) | The client DATE box is display only and fills itself with the signing time after "Sign and hold my date" | Storefront | Small | Low | Working as designed, unclear on screen | 8 |
| 8 | Wedding details form shows as due right away | Yes (code) | The due date is right (30 days before), but the row says "waiting" from booking day, turns red 14 days before the due date, and says "Due today" forever once past it | Storefront | Small | Low | Bug (wording and the overdue case) | 7 |
| 9 | Search misses "water slide" | Yes (ran the same match) | Search is one exact substring of the item name; "water slide" is not inside "Waterslide" | Storefront | Small | Low | Bug | 6 |

Fix order reasoning: 2 is a one-line cap that unblocks every large cart today. 1 is the most important but needs a decision about how per-guest items hold stock (see below), so it goes second and should be built and tested on a throwaway database before anything else in the money path moves. 3 and 4 are the next biggest source of wrong carts. The rest are small and independent.

---

## 1. Per-guest prices count as one guest

**Reproduced:** yes. Screenshot 8 shows "1 x $58.56 per guest", "1 x $91.50 per guest", "1 x $11 per guest" adding into a $4,411.06 total with "$882 today holds the date" (20%). Screenshot 1B shows the same items at their single price in the Ask GO cart, and 1A a 14-item cart totalled at $20,725.56. Production has 24 items billed "per guest" (23 public) and 2 billed "per 10 guests". Every one of them has exactly one unit. Two bookings hold a per-guest item (1 upcoming, none with a guest count). Two Ask GO leads were recommended per-guest items.

**Root cause:** the billing unit (`priceUnit`, for example "per guest") is a label only. Nothing in either repo reads it as a multiplier. Every step below takes the item's price once.

| Step | What it does with a per-guest item | Where |
|---|---|---|
| Storefront cart, drawer and checkout total | price x quantity, quantity is 1 | storefront `src/components/go/CartItems.tsx:18-20` (`lineTotal`, `cartTotal`) |
| Storefront "due today" | 20% (or the tier's amount) of that total | storefront `src/hooks/use-cart-tier.ts:49-55` |
| Ask GO total and budget check | sums each item's price once; the model sees "(per guest)" next to the price but has no rule to multiply | admin `server/routes/recommend.ts:372` (total), `:107` (catalog line) |
| Tier call (policy, contract or review) | price x 1 | admin `server/quotes.ts:103` (quantity 1 unless a package), `:121` |
| Hold and review request | price x quantity, quantity 1 for a customer | admin `server/directBooking.ts:36-47` (`quotedTotal`), `:218` |
| Stripe retainer amount | percentage of the booking's stored total, so of the one-guest price | admin `server/payments.ts:61` and `:70` (`amountsFor`) |
| GO contract (checkout quote and staff link) | one line per unit held, quantity 1, fee = price x 1 | admin `server/contract/goLoad.ts:48`, `server/contract/goDocument.ts:105` |
| Admin booking and the Bookings list | the stored total, as above | admin `server/bookingsLoad.ts` (reads `amountsFor`) |
| Staff New booking | price x quantity, and staff may type any total | admin `src/components/NewBookingModal.tsx`, `server/routes/directBookings.ts:415` |

**Why "only the contract shows the right total":** the contract's services table lets staff type the fee for each row by hand (`server/contract/goDocument.ts:113`, staff overrides win). On a contract booking the signed document's total and retainer then become the amounts that count (`server/payments.ts:58-69` reads them first). So a contract a person fixed by hand is right, and everything computed is wrong. Not verified which booking the client looked at.

**A second money bug found on the way:** the cart drawer lets a customer raise the quantity of an item that has more than one free unit, and multiplies the price by it (storefront `src/components/go/PartyDrawer.tsx:58`). The storefront never sends quantities: the tier call and the hold send only the item ids (storefront `src/lib/directInput.ts:31` and `:76`), and the admin's public hold does not read quantities at all (only the staff route does, `server/routes/directBookings.ts:415`). So a customer who sets 3 of an item sees three times the price, but the admin holds and charges for one. Not seen in a screenshot; confirmed in code.

**Why the fix is not "send the guest count as the quantity":** every per-guest item has one unit. The hold locks one free unit per quantity, so a quantity of 100 would be refused as not available. That one unit also means only one booking per date can have, say, Mediterranean Spread today.

**Smallest safe fix, in words:**
1. Decide, per item, that a "per guest" price is a rate times the order's guest count, the same rule the per-guest package already follows (`server/packagePricing.ts`). The quantity of units held stays 1 (or becomes "unlimited" for catering, see the decision below).
2. Put that rule in one admin function used by the tier call, the hold, the review request, the contract lines and the Ask GO total, so they can never disagree. The storefront shows the same figure from the tier answer, not its own sum.
3. Require a guest count when the cart has a per-guest item, as the per-guest package already does (`guest-count-required`).
4. Send the cart's quantities from the storefront on the tier call and the hold, and have the public hold read them, or remove the quantity control from the drawer until it does.
5. Add a line to the Ask GO instructions: multiply per-guest items by the guest count when checking the budget, matching rule 5 in the client's FAQ.

**Size:** large (both repos, the contract, tests). **Risk:** high. It changes amounts, retainers and contracts. Existing bookings must not be re-priced; only new tier answers and holds use the rule. Needs a throwaway database run of every money test.

**Kind:** bug.

**Decision needed first:** how per-guest items count against stock. Options: give catering and bar items no unit limit (they are services, not things); or many units; or mark them as needing crew instead. Today one booking per date blocks every other booking from the same catering item.

## 2. A cart of 20 or more items cannot be held

**Reproduced:** yes. Screenshot 9 shows the refusal word for word: "itemIds can hold at most 10 items".

**Root cause:** admin `server/routes/directBookings.ts:26` (`MAX_ITEMS_PER_BOOKING = 10`) refuses the hold at `:120`, and `server/routes/tier.ts:30` refuses the tier call above 10 the same way. Meanwhile Ask GO is allowed to recommend 20 (`server/routes/recommend.ts:29` and the instruction at `:127`), so Ask GO can build a cart that can never be held. The cap is 10, not 20: any cart of 11 or more fails.

Other limits checked: the hold body limit is 50 KB (`server/index.ts:105`), far above 20 items. The hold is limited to 5 attempts an hour per connection (`server/rateLimit.ts:22-28`), and refused attempts count, so pressing "Try again" five times locks the customer out for an hour. The storefront has no cart cap of its own.

**Smallest safe fix:** raise the item cap on the hold and the tier call to match the most a booking can hold (the unit cap is already 50, `server/directBooking.ts:29`), or at least to Ask GO's 20, and keep the two numbers in one constant. Replace the internal sentence with a plain one. Consider not counting a 400 refusal against the 5-an-hour limit.

**Size:** small. **Risk:** low. More items per hold means a bigger unit lock in one transaction; the existing 50-unit cap still bounds it. **Kind:** bug.

## 3. Ask GO changes the cart without being asked

**Reproduced:** yes, from the code. The client's exact conversation was not in the screenshots, so the delivery, space and rain exchange itself is not verified.

**When Ask GO replaces the cart versus answers a question:** there is no "answer only" state.
- Admin: the model has one tool with `ready` true or false. It is told to go ready the moment it has occasion, guest count and budget (`server/routes/recommend.ts:113`). Once ready, every later turn is ready too, and a ready answer with no items is treated as broken and retried (`:345`). So a question about rain after the cart exists comes back as ready with a new item list.
- The model never sees the cart. The storefront sends only the messages, the sub-occasion and contact details (storefront `src/state/ask.tsx:118`), so swaps and removals the customer made are invisible to it, and it picks again from scratch.
- Storefront: every ready reply replaces the whole cart (storefront `src/state/ask.tsx:138`).

**Why old messages show a new total:** the little "Your cart: N items, $total" card after each reply that changed the cart is one shared element built from the current cart (storefront `src/pages/Ask.tsx:174-180`), and it is drawn under every such message (`:205`). When the cart changes, every old card redraws with the new figures. That is how $925 became $766 on an earlier message.

**Smallest safe fix, in words:**
1. Admin: add a third kind of reply, "answer", where the model answers a question and sends no items, and say in the instructions that the cart only changes when the customer asks for a change (the client's FAQ rules 1 and 2). Accept an answer with no items as valid.
2. Storefront: send the current cart (ids) with each message so the model can keep it; replace the cart only when the reply says it changed.
3. Storefront: store the count and total on each message when it arrives, so an old card keeps its own figures.
4. Paste the client's FAQ into the instructions once its bracketed defaults are confirmed (rule 3: never invent an answer).

**Size:** medium. **Risk:** medium. It changes what Ask GO recommends; prices and picking rules stay the same. **Kind:** bug.

## 4. The cart does not persist

**Reproduced:** yes, from the code.

**Every cart in the storefront:**

| Store | Holds | Where | Survives a page load |
|---|---|---|---|
| Booking store (`BookingProvider`) | The main cart: items, package, date, guest count, checkout fields | storefront `src/state/booking.tsx` | No. Plain memory, nothing saved to the browser |
| Ask GO store (`AskProvider`) | The chat and its own separate cart ("party") | storefront `src/state/ask.tsx` | No |
| Store overlays (`StoreUiProvider`) | Whether the cart drawer, date sheet and menu are open | storefront `src/state/store.tsx` | No |

There is no `localStorage` or `sessionStorage` for any cart (only a developer maps switch uses session storage).

**How they sync:** they mostly do not.
- The header's "Cart (n)" counts only the main cart (storefront `src/components/go/Header.tsx:26`). An Ask GO cart is not in it, which is why it read "Cart (0)".
- Ask GO's cart joins the main cart only on "Book this party", and that call replaces the main cart instead of adding to it (storefront `src/pages/Ask.tsx:131`, `src/state/booking.tsx:182`). An item added from Shop all is lost at that moment.
- Ask GO's own "Cart" tab shows only Ask GO's list, so a Shop all item does not appear there.
- Starting Ask GO again (from Home, the search box, or "Ask about this") wipes the earlier chat and its cart (storefront `src/state/ask.tsx:152-153`).
- Moving between pages inside the store keeps both carts, because the stores sit above the routes. A refresh, typing an address, opening a link in a new tab, or the phone discarding the tab loses everything.

**Smallest safe fix:** one cart. Ask GO's picks go into the main cart (adding, not replacing), the header counts that one cart, and the cart (items, picks, package, date, guest count) is saved to the browser's local storage and read back on load, with a version number so an old saved cart is dropped instead of crashing. Do not wipe Ask GO's chat on every new start; offer "Start over" instead.

**Size:** medium. **Risk:** medium. Every checkout screen reads the booking store. A saved cart must be checked against the live catalog and prices on load (the admin re-prices at the hold anyway). **Kind:** bug.

## 5. Wrong occasion on the lead

**Reproduced:** yes, in production data. On Nov 15 an Ask GO lead whose text mentions a graduation and a "Talk to us" lead with the occasion "Team building" were created in the same minute, which matches screenshots 10 and 11.

**How the occasion travels:**
1. The storefront keeps one sub-occasion for the whole visit (`subOcc` in storefront `src/state/booking.tsx`). It is set when the customer adds a package on Home (`src/pages/Home.tsx:153-156`) or picks an occasion at checkout (`src/pages/ItemWho.tsx:215`). Nothing clears it when a new cart or a new Ask GO chat starts, and Ask GO never sets it from the conversation.
2. Ask GO sends it to the admin as "The customer selected sub-occasion: ..." in the model's instructions (storefront `src/state/ask.tsx:118`, admin `server/routes/recommend.ts` `buildSystem`). So a stale value also misleads the model.
3. "Talk to us" from Ask GO sends the same value as the lead's occasion (storefront `src/pages/Ask.tsx:159`, `src/lib/concierge.ts:60`). The admin stores what it is sent (`server/routes/conciergeLeads.ts`).
4. The Calendly link's note is "Interested in:" plus the items, falling back to the occasion only when there are none (storefront `src/lib/concierge.ts:34-43`). From Ask GO the items are always there, so the Calendly note itself should not say "Team Building event". Where Calendly got that wording is **not verified**; it may be Calendly's own event type or what the customer picked there.

Where "Team building" came from in that session is **not verified**. No published package carries that occasion, so it was most likely picked on an earlier test checkout in the same visit.

**Smallest safe fix:** do not send the remembered occasion with Ask GO or its "Talk to us" lead unless the customer picked it on this visit's Ask GO screen; clear it whenever a new cart or a new Ask GO chat starts; and let the admin write the occasion it reads from the conversation onto the lead (it already logs the chat as the lead's theme).

**Size:** small. **Risk:** low. **Kind:** bug.

## 6. Clicking an item card does nothing

**Reproduced:** yes, from the code, at both widths (the markup is the same; only the grid changes).

| Place | What a click or tap does |
|---|---|
| Home | Shows categories and packages, not single items. A category opens Shop all filtered to it. A package card has an Add button only. |
| Shop by category, Shop all, search results page | The card itself (photo, name, description) does nothing (storefront `src/pages/Browse.tsx:257`, an `article` with no click). Only the "Add" button acts. Add opens the options drawer only when the item has options to choose; otherwise it adds and opens the cart. |
| Header search box | An item opens Shop all filtered to that item's name. |
| Ask GO cart | Each row has Swap and Remove only. |

There is no item detail view anywhere in the storefront. **Kind:** missing feature, working as built.

**Smallest safe fix:** make the whole card open a small detail sheet (the existing drawer component) with the photo, the full description, the price and unit, sizes and power or water needs once the item fields hold them, and the Add button. Same sheet from search and from Ask GO rows.

**Size:** medium (a sheet), large if it needs new item fields such as size and power. **Risk:** low. **Kind:** feature request.

## 7. The contract date cannot be filled in

**Reproduced:** yes. Screenshot 4 is the GO contract at checkout ("Sign and hold my date"): the client's DATE box beside the signature is empty while GO's shows "Nov 14, 2026".

**Root cause:** that box is not a field. It is display only and shows the signing time once the contract is signed (storefront `src/components/go/contract/GoContractDocument.tsx:349`, `signedOn(signature?.signedAt)`). The admin stamps the real time when the signature is received; nothing the customer types is used. While signing it is blank, which looks like a field they are meant to fill.

**Smallest safe fix:** while signing, show today's date in grey once a name is typed, or the words "Filled in when you sign". Do not make it editable: the date on a signed contract must be the server's.

**Size:** small. **Risk:** low (display only). **Kind:** working as designed, unclear on screen.

## 8. The wedding details form shows as due right away

**Reproduced:** yes, from the code.

**Root cause:** the due date is correct. It is 30 days before the event (admin `server/weddingDetails/template.ts:370`, `server/weddingDetails/logic.ts:34`), and screenshot 6 shows it right (event Sat, Feb 27, details due Thu, Jan 28). What reads as "due right away" is the storefront's wording:
- The row and the confirmation screen say "Your wedding details form is waiting." from the day of booking until it is sent (storefront `src/components/go/WeddingRow.tsx:27`, `src/components/go/WeddingWaiting.tsx:30`).
- The row turns red with "Due in N days" from 14 days before the due date, which is 44 days before the event (storefront `src/lib/weddingApi.ts:195-201`). A wedding booked 44 days out or less is red from the first moment.
- Once the due date has passed it says "Due today" every day, never "overdue" (`:201`). A wedding booked less than 30 days before the event is shown as "Due today" at once.
- On the admin side, "Wedding details missing" shows in Today and Bookings for any wedding within 45 days (admin `server/today.ts:17`, `server/bookingsList.ts:24`), so a late booking is flagged on the first day too.

**What a customer sees when the event is under 30 days away:** "Your wedding details form is waiting." in red with "Due today", from the moment they book.

**Smallest safe fix:** say "Due Jan 28" plainly until a week before the due date; turn red only in that last week; for a past due date say "Please send it as soon as you can" instead of "Due today"; and for a booking made inside 30 days, set the due date to a few days after booking (or 7 days before the event, whichever is later). Match the admin's 45-day flag to the same rule.

**Size:** small. **Risk:** low. **Kind:** bug in wording and in the overdue case.

## 9. Search misses spelling variants

**Reproduced:** yes. The match used is the same plain substring check: "big wave single lane waterslide" does not contain "water slide", so nothing is found.

**How search matches today:** lower case, then one exact substring.
- Header search box: the item name only (storefront `src/components/go/SearchBox.tsx:32`); categories by name (`:31`).
- Shop all results page: name plus category (storefront `src/pages/Browse.tsx:108`).
- No word splitting, no ignoring of spaces or hyphens, no plurals, no descriptions, no synonyms.

**Smallest safe fix:** split the search into words and require each word to appear; compare with spaces and hyphens removed on both sides (so "water slide" finds "Waterslide"); also search the description; allow a simple plural ("slides"). A short synonym list (bounce house and bouncy castle, DJ and music) can come later.

**Size:** small. **Risk:** low. **Kind:** bug.

---

## Also asked (read only)

**The "Use the GO contract" switch.** Settings > Contract and policy, section "Which contract new bookings get". Exact label: "Use the GO contract for new bookings". In production it is **off**. It only decides the contract a staff-sent link gets (admin `server/contracts.ts:476-482`): off means the older "Event Services Agreement" layout with the rental policy text, which is screenshot 7. Checkout at the storefront always uses the GO contract for a contract order whatever the switch says (`server/quotes.ts` `issueQuote`), which is screenshot 4. So a customer can see two different contracts depending on how they booked.

**The $1,000 line between the rental policy and the contract.** Yes, it can be changed. Settings > Booking rules, section "Contracts and checkout", field "Contract required over ($)". Production value 1000 (so $1,001 needs a contract). The checkbox under it, "Contract required for crewed items", is on.

**Deleting or deactivating a crew member.** Deactivate only, no delete. Crew and Gigs > Crew, open the person, untick "Active, can be offered gigs", then Save changes. The row and its history stay, and inactive people sort to the bottom with an "Inactive" label (admin `src/components/CrewModal.tsx:21` and `:83-85`, `server/routes/crew.ts:86`).

**Post-event messages.** One exists: "Thanks after the event" in Messages > Templates, sent the day after the event by text and email, once per booking (admin `server/triggers.ts:491`). It is on in production for both (no override saved) and has been sent twice. There is no review request message and no later follow up.

## Other things in the screenshots (not in the nine)

- **The deposit percentage changed.** Screenshots 1A, 4 and 8 show 20%. Production is now **30%** (Settings > Booking rules). When and by whom is not verified (Settings > Team, Recent changes would show it).
- **The rental policy text says "deposit".** Screenshots 7 and 9 show the saved policy wording ("A deposit of 20% of your total..."). That is client content, and its "20%" no longer matches the 30% setting.
- **Screenshot 2, "That phone or email and password don't match."** The address typed differs from the one on the account in screenshot 3. Most likely a typing mix-up, not a bug. Not verified.
- **The client's FAQ document** asks Ask GO to answer from it, never change the cart because of a question, multiply per-guest items, and flag space and power needs. None of that is in Ask GO's instructions yet. Several answers are still in brackets awaiting the owner's decision.
