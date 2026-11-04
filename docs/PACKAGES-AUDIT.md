# Packages and discounts: read-only audit (2026-11-03)

Read from the admin repo at main `9462210`, the storefront repo at main, and production data. No code was changed.

## Summary

A package today is a fixed-price bundle of catalog items. Andy names it, writes a description, picks the items and how many units of each, types one bundle price by hand, ticks the sub-occasions it is offered under, adds search keywords (or asks Claude to suggest some), adds a card tag ("Most booked") and a guest note ("Up to 25 kids"), uploads one photo, and publishes it. The storefront shows published packages on Home and a customer adds one to the cart as its items plus the bundle; the hold then locks that many units of each item and charges the bundle price plus any add-on picks. There are three packages in production, all published.

The price is always the hand-typed bundle price, never the sum of the items. The admin list shows what the items add up to next to the bundle price so Andy can see the gap, and that gap is the only "discount" a package has. There is no per-guest pricing, no guest-count tiers, no bulk or percentage discount, no minimum guests, no coupon model and no service charge, gratuity or tax field anywhere in the admin, the API or the storefront. The GO contract has a discount percent and discount dollar line that staff fill in on a booking by hand, and its wording says tip and tax are not included. Ask GO builds a party from items only and never reads packages.

To sell a themed party priced per guest with a guest count the customer picks, the smallest additive change is: a pricing mode on the package (fixed, or per guest with a base, a minimum and a maximum guest count), a guest count on the booking, the hold computing the total from the count, and the storefront asking for the count on the package card or in the drawer. Six columns, no new tables, and nothing changes for the three fixed-price packages that exist.

## 1. The Package model

Table `packages`, one row per package, scoped to the account.

| Field | Meaning |
|---|---|
| `id`, `accountId` | Cuid, and the account it belongs to. |
| `name` | Required. Shown on the card and in the admin list. |
| `description` | Optional free text. Shown on the public response; the storefront card no longer prints it since Block S1.1 (it prints `tag` and `guestNote`). |
| `price` | Required, decimal, dollars. The bundle price, typed by hand. Not a sum, not computed from the items; "the gap is Andy's discount" is the design note in the schema. |
| `status` | `Draft` or `Published`. Only Published packages are public. Publishing needs at least one occasion and at least one item. |
| `keywords` | Up to 20 short customer-facing search terms (40 characters each), typed or suggested by Claude from the package's contents. Sent on the public response for the storefront's search. |
| `occasions` | The storefront sub-occasion strings the package is offered under ("Birthday", "Reception only"), up to 30, each from the fixed occasion list. A package appears under every one of them. There is no separate occasion versus sub-occasion field: the groups ("Kids party", "Wedding") are derived from the sub-occasions when the public feed is read. |
| `photoUrl` | Optional, one photo as a data URL (compressed in the browser) or a URL. One photo only. |
| `tag` | Optional, up to 20 characters, the card badge. Block A2. |
| `guestNote` | Optional, up to 40 characters, the card size hint ("Up to 25 kids"). Display only; nothing reads it as a number. Block A2. |
| `createdAt`, `updatedAt` | Timestamps. |

So: the price is fixed; a package can carry its own description, one photo, tag, guest note, publish state and one or more sub-occasions (the occasion group follows from them). It has no guest count, no price mode, no discount and no date range.

Production has 3 packages, all published.

## 2. Items inside a package

Table `package_items`: `(packageId, itemId, quantity)`, primary key on the pair.

- **Quantity per item:** yes, 1 to 99 per item, set in the admin. The hold locks that many units of the item.
- **An item in several packages:** yes. The key is per package, so the same item can be in any number of packages. Deleting an item removes it from every package (cascade); deleting a package removes its rows and nothing else.
- **Add-on choices inside a package:** there is no package-level choice ("choice of one add-on"). What exists is the item's own add-on groups (Flavor, Toppings, with one pick or many since Block A3). The public package feed sends each item's add-on groups along, the storefront routes a package with a configurable item through the options screen, and the hold prices every pick on top of the bundle price. A package cannot pre-select, hide or bundle an add-on, and cannot offer "pick one of these three items".
- **Booking a package:** `POST /api/bookings/direct` with `packageId` and the item ids. The server loads the package (must be Published), refuses the hold when the item list does not match the package's items exactly ("The items don't match the package. Book the package as it is, or book the items on their own."), takes each item's quantity from the package, checks add-ons, and then does exactly what an item booking does: locks that many free units of each item on the date (a unit short means the hold is refused), creates one gig per skill per unit for crewed items, writes the lead, the booking with `packageId`, the agreement and the cart snapshot (the package's id, name and price are stored on the booking's lead data and the booking row). Availability, crew and the calendar see only units and gigs; they do not know a package was involved. The total is the bundle price plus add-on deltas times quantity. Staff can override the total on a phone booking; a customer cannot.
- **Review routing:** the package's occasions join the customer's chosen occasion for the review rule (a package offered under Wedding goes to Design Requests when Wedding is a review occasion).

## 3. Pricing, discounts and coupons

None of the following exists on packages or items: per-guest pricing, guest-count tiers, bulk discounts, percentage discounts, minimum or maximum guests, or a structured "starting at". The only "starting at" in the system is free text in an item's `priceUnit` ("per event, starting at"), which the storefront prints next to the number and nothing computes with.

What does exist:

- **The package gap.** The admin list shows "Bundle price" next to "Items add up to" (sum of the items' own prices times quantity, with a note when an item has no price). The difference is the discount, implicit, unlabeled, and not shown to the customer.
- **Booking discount lines on the GO contract.** `bookings.discount_percent`, `discount_amount` and `discount_description` (Block T1 contract settings). Staff type them on a booking in the admin; the contract's money math is Subtotal, then Total Discount = percent of subtotal plus dollar amount, then Total, then the retainer percent of that. No customer-facing route sets them and no rule computes them. A tier 2 quote at checkout always carries a discount of null.
- **Retainer percent** (`depositPercentage`) is global, not per package.

There is no coupon, promo code, voucher or discount table anywhere in the admin, the storefront or the docs.

## 4. Service charges, gratuity and tax

No field, setting or line for a percentage added on top of a price: no service charge, no gratuity, no tax rate, on packages, items, add-ons, bookings or the account. Add-on `priceDelta` is a flat dollar amount per unit, not a percent.

The GO contract's terms say tip and tax are not included and applicable taxes will be added as required by law; the document's fee lines are the items at their prices and the only automatic lines are subtotal, discount, total, retainer and balance. A 22% bar service charge or a 23% cigar gratuity today can only be folded into the item price by hand or added as a flat-dollar add-on option.

## 5. How the storefront reads packages

- **Route:** `GET /api/packages/public`, public, no session, behind the 120-a-minute read limiter. With `?occasion=` it returns that sub-occasion's published packages (never cached). With no occasion (Block A2) it returns every published package, cached in memory for a minute and dropped on any admin package write.
- **Shape:** `{ occasion, packages: [{ id, name, description, price, keywords, occasions, groups, occasion, photoUrl, tag, guestNote, items: [{ itemId, name, category, price, priceUnit, photoUrl, quantity, addonGroups }] }] }`. Built field by field from an allowlist; drafts never appear.
- **Storefront use:** Home loads the whole list in one call (falling back to per-occasion calls when that fails) and shows "Party packages" cards with the photo, name, tag, guest note and price. "Add package" puts the items into the cart with their quantities and remembers the bundle (id, name, price); an item with a required add-on group goes through the options screen first. Checkout sends `packageId` with the item ids. The tier call prices the cart from the same package price.
- **Ask GO:** `POST /api/recommend` reads items only: it loads the catalog's priced items, sends public item fields to Claude with the customer's occasion, guest count and budget, and returns a set of real items with a total. It never loads, suggests or links a package. So yes, Ask GO builds from items alone, and packages are reachable only from the Home cards and search.

## 6. The admin Packages page today, step by step

1. Open Packages & Themes in the sidebar. A table lists every package: photo, name, occasions, item count, bundle price, "Items add up to", status pill, and Edit and Publish or Unpublish buttons. Filter buttons: All, Draft, Published.
2. "New package" opens the editor. Fields: Name, Tag (20 characters), Guest note (40 characters), Description, Bundle price (dollars, required), Occasions (checkbox grid by group with sub-occasions; publishing needs at least one), Keywords (type and add, remove each, or "Suggest keywords" which asks Claude from the name, description and items), Photo (drop zone, compressed in the browser, Remove photo).
3. Items: a search box over the catalog; pick an item to add it with quantity 1; change the quantity (1 to 99) in the row; remove a row. The editor shows the running "Items add up to" sum and notes any item with no price.
4. Save creates the package as Draft (or saves changes to an existing one). The editor never publishes.
5. Back on the list, Publish checks for at least one occasion and one item and flips the status; Unpublish takes it off the storefront at once. Delete exists on the API (`DELETE /api/packages/:id`) and in the list.
6. Every write clears the public one-minute cache, so the storefront sees the change on its next load.

What Andy cannot do here: set a price that depends on guests, mark a discount as a discount, attach a percent charge, offer a choice of items, set a date range or a limit on how many times a package can be booked, or see how often a package has been booked.

## 7. Gaps for theme parties, and the smallest additive changes

Goal: a themed party ("Unicorn party") priced per guest, where the customer picks the guest count and the total follows.

Missing today:

1. A way to say a package is priced per guest rather than as one bundle.
2. A guest count on the booking (there is `gigs.guest_count` for the crew page, filled by staff, but nothing on the booking or in the hold).
3. A total that comes from the count (the hold and the tier quote both read `package.price` as the total).
4. A place for the customer to choose the count.
5. Optionally, a minimum and maximum count, and a base fee.

Smallest additive set (six columns, one storefront control, no new tables, nothing changes for existing fixed-price packages):

| Where | Change |
|---|---|
| `packages` | `pricing_mode` text, default `fixed` (`fixed` or `per_guest`); `base_price` decimal nullable (a flat part, for a setup fee); `min_guests` and `max_guests` integer nullable. `price` keeps its meaning for `fixed` and becomes the per-guest rate for `per_guest`. |
| `bookings` | `guest_count` integer nullable, stored as sent. |
| `POST /api/bookings/tier` and `POST /api/bookings/direct` | Accept `guestCount`. For a `per_guest` package: require it, refuse outside min and max with a plain sentence, and set the quoted total to `base_price + price × guestCount` (plus add-ons as today). The quote hash already pins the cart, so the count must be part of it. |
| `GET /api/packages/public` | Send `pricingMode`, `basePrice`, `minGuests`, `maxGuests` so the card can say "from $N per guest". |
| Admin editor | A "Priced" choice: "One bundle price" or "Per guest", and when per guest the base, minimum and maximum fields. The list's "Items add up to" column is not meaningful for per-guest packages and should say so. |
| Storefront | A guest count field on the package card or in the drawer for per-guest packages, sent with the tier call and the hold; the total line updates from the tier answer as it does now. |
| Contract | The GO document's package line prints "Unicorn party, 24 guests at $35" and the fee; `goDocument` already builds lines field by field, so this is one more detail string. |

What this does not cover, and could follow later: guest-count price tiers (1 to 20 at one rate, 21 to 40 at another; one more small table), a service charge or gratuity percent per item or package (one nullable percent column on `items` and `packages` plus a contract fee line), and inventory that scales with guests (today a package holds a fixed number of units regardless of count, which is right for "one bounce house" and wrong for "one chair per guest").
