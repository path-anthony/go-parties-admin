# Settings cleanup plan (Block A12, step 1)

Written 2026-11-10 on branch `a12-settings` (from main `18d399d`). Step 1 was the plan. Step 2 (applied, awaiting merge) followed it with the decisions in section 4. No stored value changed and no migration was needed.

Goal: one place for every setting, fewer pages, plain names. No setting changes value. No migration is needed: no setting is stored twice in the database (see "Duplicates" below).

## 1. What Settings is today

Nine sidebar pages under Settings, plus three Messages pages that hold settings-like content. Storage is `accounts.<column>` unless noted. "Owner" means the server refuses the save for Staff (`STAFF_FIELDS` in `server/routes/settings.ts` lists the only fields Staff may change).

### Business rules (`/settings/business-rules`, Owner)

| Section | Field today | Stored in | Read by |
|---|---|---|---|
| Rush orders | Minimum booking notice (hours) | min_booking_notice_hours | settings, routes/settings |
| Rush orders | Rush order contact phone | rush_contact_phone | message context (it is the `companyPhone` in every text and email), Ask GO, bids, hold route |
| Review and retainer | Full review threshold ($) | full_review_threshold | tiers, quotes, review, hold |
| Review and retainer | Occasions requiring review | review_occasions | tiers, quotes, review, hold |
| Review and retainer | Retainer percentage (%) | deposit_percentage | contracts, payments, portal, tokens, messages, tier route |
| Review and retainer | Cancellation window (days) | cancellation_window_days | contracts, tokens, messages, GO contract |
| Review and retainer | Require the agreement checkbox | require_agreement_checkbox | hold |
| Review and retainer | Require an account to book | require_customer_account | hold |
| Agreements and checkout payment | Contract required over ($) | contract_required_over | tiers, quotes, hold |
| Agreements and checkout payment | Always require a contract for crewed items | contract_required_for_crewed | tiers, quotes, hold |
| Agreements and checkout payment | Release unpaid contract holds after (days) | contract_hold_release_days | holds |
| Agreements and checkout payment | Small rentals (tier 1) collect | tier1_collect | payments, portal, tier route |
| Agreements and checkout payment | Save the card for the balance | save_card_for_balance | payments |
| Spending and abuse limits | Ask GO messages per day (public) | ai_daily_cap | Ask GO gate |
| Spending and abuse limits | Storefront bookings per day | direct_booking_daily_cap | hold |
| Spending and abuse limits | Release unpaid storefront holds after (days) | hold_release_days | holds |
| Spending and abuse limits | Require bot check fields on the public forms | require_bot_check | bot check |

### Policies and contracts (`/settings/policies`, Owner)

| Section | Field today | Stored in | Read by |
|---|---|---|---|
| Cancellation and retainer policy | The policy text (versioned) | `policy_versions` | tier 1 checkbox text, old-layout contract |
| Contract signature for GO | Authorized signer name and title | authorized_signer_name, authorized_signer_title | contracts |

### Contract terms (`/settings/contract-terms`, Owner)

| Section | Field today | Stored in | Read by |
|---|---|---|---|
| (one editor) | Header, pages 2 and 3, clauses, notes and acceptance, with a live preview (versioned) | `contract_terms_versions` | GO contract (go-v2) |

### Contract settings (`/settings/contract-settings`, Owner)

| Section | Field today | Stored in | Read by |
|---|---|---|---|
| Rollout | Use the GO contract for new contracts | use_go_contract | contracts |
| Company as printed | Company name, Contract phone, Address line, Email, Website, Footer line | contract_company_name, contract_phone, contract_address_line, contract_email, contract_website, contract_footer_line | GO contract, quotes, payments (Stripe description), Google Calendar events |
| Company as printed | Logo | contract_logo | GO contract, PDF |
| Numbers the wording binds to | Balance due (days before the event) | balance_due_days | contract, portal, notifications, customer route |
| Numbers the wording binds to | Sign and pay by (days after sending) | sign_and_pay_window_days | contract header, quotes |
| Numbers the wording binds to | Reschedule fee (%), Outside planner charge (%), Returned check fee ($) | reschedule_fee_percent, outside_planner_charge_percent, returned_check_fee | contract wording |
| Contract signature for GO | Same signer panel as on Policies and contracts | same two columns | same |
| Services table rows | Rows, labels, items, order | `contract_service_rows` | contract |

### Lead pipeline (`/settings/lead-pipeline`, Staff can edit)

| Field today | Stored in | Read by |
|---|---|---|
| Lead columns (names, order) | `lead_statuses` | Leads board, follow-up messages (the Won and Lost columns stop follow-ups) |

### Notifications (`/settings/notifications`, Staff can edit)

| Section | Field today | Stored in | Read by |
|---|---|---|---|
| Staff notifications and reminders | Staff notification phone | staff_notify_phone | contract signed alert, crew questions |
| Staff notifications and reminders | Staff notification email | staff_notify_email | same |
| Staff notifications and reminders | Balance reminder window (days) | balance_reminder_window_days | reminder check, automation loader |
| Daily digest | Send the daily digest | digest_enabled | digest |
| Daily digest | Digest email | digest_email | digest |

### Integrations (`/settings/integrations`, read only except Google, Owner)

Text messaging, Email, Automation status, Stripe, Google Maps (status, today's lookups, last error, Try an address), Storefront web address: all read-only status from environment variables. Google Calendar card: connect and disconnect, GO calendar, invites calendar, send invites, sync stage (`google_calendar_id`, `google_invites_calendar_id`, `google_send_invites`, `google_sync_stage`; read by `server/google/`).

### Home photos (`/settings/home-photos`, Staff can edit)

Photo list, add, order, on and off, delete. Stored in `hero_slides`; read by the public `GET /api/hero`.

### Team (`/settings/team`, Owner)

People, roles, invites, resets, two-step. Stored in `admin_users` and related. Read by sign-in and every actor record.

### Settings-like content outside Settings

- Messages > Templates: wording and on or off for every automated text and email (`message_templates`).
- Crew & Gigs > Skills: the skill list (`skills`).
- No page at all: `automation_started_at` (system, set once), `accounts.name` and `accounts.email` (nothing reads either).

## 2. Findings

### Same setting shown on two pages

1. **Contract signature for GO** is on both Policies and contracts and Contract settings. One pair of columns, two copies of the same panel.
2. **Retainer percentage and cancellation window** are edited on Business rules and shown again, read only, on Contract settings and in the Contract terms preview. One column each, three places a person might look.
3. **Balance due days** is edited on Contract settings, but it is a booking rule (the portal and the notifications read it).

### Two things that mean nearly the same

None is stored twice in the database. These are the near-duplicates:

1. **Company name.** `contract_company_name` ("Go Event Group") feeds contracts, quotes, Stripe and calendar events. Texts and emails use a constant in code, `COMPANY_NAME` ("GO! Event Group"). Two spellings, two sources. Merging them would change the words customers read, so this block does not.
2. **Phones.** `contract_phone` ("413.391.4635 (GO!DJ)") is the contract header and calendar invites. `rush_contact_phone` is labelled a rush contact but is also the company phone in every text and email, Ask GO and crew pages. `TWILIO_PHONE_NUMBER` is the sending number.
3. **Footer line** repeats the address, phone, email and website that sit in four fields just above it.
4. **Release unpaid holds** exists twice: `hold_release_days` (storefront holds, tier 1) and `contract_hold_release_days` (tier 2). Two columns, two rules in `server/holds.ts`. Not a duplicate, but they sit on two sections and read as one setting.
5. **Three staff contacts:** staff notification phone, staff notification email, digest email. Different jobs, three fields.
6. **Rental policy text versus Contract terms.** Two versioned texts. The policy text is what a small rental customer ticks and what the old-layout contract prints. The GO contract (go-v2) uses only Contract terms. They are different documents for different tiers, so both stay, on one page, labelled by who they apply to.
7. **Balance reminder window (days)** is read by the reminder check, while the "balance due in 7 days" bell notification uses a fixed 7 in `server/notifications.ts`. The setting does not control that notification. Flagged, not changed.

### Help text that is out of date

- Retainer percentage: "Recorded only; nothing is charged yet." Stripe now charges it.
- Cancellation window: "nothing enforces it yet." It is printed in contracts and messages.
- Balance reminder window: "Nothing runs it on a schedule yet." The planner runs reminders.
- Save the card for the balance: "Nothing charges automatically yet." Still true; keep.

I will correct the first three sentences. That is wording only, not a value.

### Read by nothing

`accounts.name` and `accounts.email` (no reader, no screen). `automation_started_at` is read by the planner but has no screen on purpose. None changes in this block.

### Sections that belong together

- All the company facts printed on a contract are really the business's identity (the calendar invites use them too), so they belong on a Business page, not on Contract settings.
- Retainer, balance due, cancellation, hold release and "require an account" are all rules about how a booking is made and paid. Today they are spread over three pages.
- Staff alerts, the digest and the lead columns all decide who hears what and when.

## 3. Proposed structure: 7 pages

Settings group, in this order. Every old address redirects.

| # | Page | Address | Who can edit | Replaces |
|---|---|---|---|---|
| 1 | Business | `/settings/business` | Owner | company fields from Contract settings, the rush phone from Business rules |
| 2 | Booking rules | `/settings/booking-rules` | Owner | Business rules, balance due days from Contract settings |
| 3 | Contract and policy | `/settings/contract-and-policy` | Owner | Policies and contracts, Contract terms, the rest of Contract settings |
| 4 | Messages and notifications | `/settings/notifications` | Staff | Notifications, Lead pipeline, a link to Messages > Templates |
| 5 | Home photos | `/settings/home-photos` | Staff | unchanged |
| 6 | Integrations | `/settings/integrations` | Owner (Google) | unchanged address |
| 7 | Team | `/settings/team` | Owner | unchanged |

### Field by field

| Field today | Moves to | New label |
|---|---|---|
| Company name | Business > Company | Business name (as printed on contracts and calendar events) |
| Address line | Business > Company | Business address |
| Contract phone | Business > Company | Phone on contracts |
| Rush order contact phone | Business > Company | Phone customers call or text (texts, emails, rush bookings) |
| Email | Business > Company | Business email |
| Website | Business > Company | Website |
| Footer line | Business > Company | Footer on every contract page |
| Logo | Business > Company | Logo |
| **Require an account to book** | **Booking rules > Who can book online (first section)** | **Require an account to book** |
| Require the agreement checkbox | Booking rules > Who can book online | Require the rental policy checkbox |
| Minimum booking notice (hours) | Booking rules > Short notice | Short-notice window (hours) |
| Full review threshold ($) | Booking rules > Staff review | Send to staff review over ($) |
| Occasions requiring review | Booking rules > Staff review | Always send these occasions to staff review |
| Contract required over ($) | Booking rules > Agreements | Contract required over ($) |
| Always require a contract for crewed items | Booking rules > Agreements | Contract required for crewed items |
| Small rentals (tier 1) collect | Booking rules > Payment | Small rentals pay at checkout |
| Retainer percentage (%) | Booking rules > Payment | Retainer (% of total) |
| Balance due (days before the event) | Booking rules > Payment | Balance due (days before the event) |
| Save the card for the balance | Booking rules > Payment | Save the card for the balance |
| Cancellation window (days) | Booking rules > Cancellation and holds | Free cancellation window (days before the event) |
| Release unpaid storefront holds after (days) | Booking rules > Cancellation and holds | Release unpaid holds after (days), small rentals |
| Release unpaid contract holds after (days) | Booking rules > Cancellation and holds | Release unpaid holds after (days), contract bookings |
| Storefront bookings per day | Booking rules > Limits and bot protection | Storefront bookings per day |
| Ask GO messages per day (public) | Booking rules > Limits and bot protection | Ask GO messages per day |
| Require bot check fields on the public forms | Booking rules > Limits and bot protection | Require bot check on public forms |
| Policy text (versioned) | Contract and policy > Rental policy | Rental policy for small bookings |
| Use the GO contract for new contracts | Contract and policy > GO contract | Use the GO contract for new bookings |
| Contract terms editor (versioned) | Contract and policy > GO contract wording | GO contract wording |
| Sign and pay by (days after sending) | Contract and policy > Contract numbers | Sign and pay within (days of sending) |
| Reschedule fee (%) | Contract and policy > Contract numbers | Reschedule fee (%) |
| Outside planner charge (%) | Contract and policy > Contract numbers | Outside planner charge (%) |
| Returned check fee ($) | Contract and policy > Contract numbers | Returned check fee ($) |
| Authorized signer name and title (one panel, was shown twice) | Contract and policy > Who signs for GO | Who signs for GO (name, title) |
| Services table rows | Contract and policy > Services table | Services table on the contract |
| Staff notification phone | Messages and notifications > Staff alerts | Staff alert phone |
| Staff notification email | Messages and notifications > Staff alerts | Staff alert email |
| Balance reminder window (days) | Messages and notifications > Reminders | Balance reminder window (days) |
| Send the daily digest | Messages and notifications > Daily digest | Send the daily digest |
| Digest email | Messages and notifications > Daily digest | Digest email |
| Lead columns | Messages and notifications > Lead columns | Lead columns |
| (link) Message wording and on or off | Messages and notifications > Message wording | Edit message templates (opens Messages > Templates) |
| Home photos | Home photos | unchanged |
| Google Calendar card, Stripe, Maps, text, email, storefront status | Integrations | unchanged |
| Team | Team | unchanged |

Every column above stays where it is in the database. The screens change; the stored values do not. The labels in this table were the proposal. The final labels and help lines are in section 6.

## 4. Decisions (made, and applied)

1. **Templates** stay in Messages. Messages and notifications has an "Edit message templates" button that opens them.
2. **Lead columns** are on Messages and notifications.
3. **Contract and policy** is one stacked page with an "On this page" list of jump links. `CLAUDE.md` now says Settings is capped at seven pages and each is a stack of sections with jump links, never tabs.
4. **Stale help text** fixed (wording only): the retainer, the cancellation window and the balance reminder window now say what they really do.
5. **Balance reminder window** now also drives the "Balance due soon" bell alert, which used a fixed 7 days. Same default (7), so nothing changes until someone changes the setting. One test covers it.
6. **Rush contact phone** is on Business, labelled "Company phone (used in texts and emails)".
7. **Unpaid holds**: both settings kept, side by side on Booking rules, labelled "Small rentals" and "Contract bookings".
8. **Plain-language guidance** on every page, section and field. The full list is in section 6.

### Left alone on purpose

- **Two spellings of the company name.** Texts and emails use "GO! Event Group" (a constant in code). Contracts, quotes, Stripe and calendar events use the Business name field ("Go Event Group"). They stay separate. The Business name help line says so, so nobody expects that field to change the texts.
- **Unused account columns.** `accounts.name` and `accounts.email` have no reader and no screen. They stay in the database untouched.
- `automation_started_at` has no screen, by design.

## 5. How step 2 was done and proved

- The big forms were split so each section saves only its own fields (the settings save already takes any subset). One generic section form replaced six one-off forms; the contract logo, the policy, the contract wording, the services table, the lead columns, the photos and the Google card moved as they were.
- New sidebar entries and pages. Old addresses redirect: Business rules goes to Booking rules; Policies and contracts, Contract terms and Contract settings go to Contract and policy; Lead pipeline goes to Messages and notifications. Integrations keeps its address, so the Google sign-in return and the "Address checks paused" alert still work.
- `src/settings.test.tsx` renders all seven pages and lists every control by its field name. It checks the list against `src/settingsFields.before.json` (every control the nine old pages had), so none is lost and none shows twice, and checks each sits on the page the plan says. It also checks the wording rules (intro on every page, a line on every section, a label and help on every field, no em dashes, no internal names).
- `src/nav.test.tsx` checks the seven pages and the redirects.
- A saved value can only change if someone edits a box and presses Save on that section; opening and closing a page writes nothing.

## 6. Wording for review

Every line below is the text on the screen, listed straight from `src/settingsCopy.ts`. Run `npm run settings:copy` to refresh this list after editing the wording.

<!-- copy:start -->

### Business (`/settings/business`)

**Page line:** Your business details, as customers see them on contracts, calendar invites, texts and emails.

**Company details.** These print on every contract and show on calendar invites. New contracts and invites use any change right away. Signed contracts don't change.

- **Business name.** Printed at the top of contracts. Example: Go Event Group. Texts and emails say "GO! Event Group" and don't follow this box.
- **Business address.** Printed on contracts. Example: 767 New Britain Ave, Farmington, Connecticut 06032.
- **Phone on contracts.** Printed in the contract header. It doesn't change the number texts come from.
- **Company phone (used in texts and emails).** The number customers are told to call or text in our texts and emails, on crew pages, and when they book on short notice. Leave it blank and we use the texting number.
- **Business email.** Printed on contracts and calendar invites. Example: info@thegoeventgroup.com.
- **Website.** Printed on contracts. Example: www.thegoeventgroup.com.
- **Footer on every contract page.** The small line at the bottom of each contract page. It's typed on its own, so change it too if your address or phone changes.

**Logo.** The picture at the top of contracts and their PDFs. New contracts use it right away. Signed contracts don't change.

- *Under the logo.* Drop a picture on the box or pick one from your computer.
- *When your own logo is in use.* Your own logo is in use.
- *When the placeholder is in use.* The built-in placeholder is in use until you add a logo.

### Booking rules (`/settings/booking-rules`)

**Page line:** How bookings are made and paid on the store: who can book, what needs a contract, and what customers owe and when.

**Who can book online.** Controls who can hold a date on the store. Customers feel it at checkout, right away. Bookings you make in the admin are never blocked.

- **Require an account to book.** On: customers have to sign in or create an account before they can hold a date. Off: they can book as a guest.
- **Require the rental policy checkbox.** On: a booking without the ticked box is turned away. Off: it still goes through, marked "box not ticked". Turn this on once the store shows the checkbox.

**Short-notice bookings.** Marks bookings made close to the event so you can handle them differently. Customers see your company phone when they book inside this window. Applies to new bookings right away.

- **Short-notice window (hours).** An event starting sooner than this is marked RUSH. It still goes through. 72 means anything within 3 days is rush. 0 turns it off.

**Staff review.** Some bookings go to Design Requests for your team to look at before a date is held. The customer sees that you'll be in touch instead of a hold. Applies to new bookings right away.

- **Send to staff review over ($).** A booking with a total above this goes to staff review. 15000 means a $15,001 booking is reviewed and a $15,000 one isn't.
- **Always send these occasions to staff review.** Tick a whole group, like Wedding, or single occasions. Those bookings go to staff review whatever the price.

**Contracts and checkout.** Decides what a customer signs at checkout: the rental policy checkbox for small rentals, or the GO contract for bigger or crewed bookings. Applies to new bookings right away.

- **Contract required over ($).** A booking with a total above this signs the GO contract at checkout. 1000 means $1,001 needs a contract and $1,000 only needs the checkbox.
- **Contract required for crewed items.** On: anything that needs crew, like a DJ or a photographer, always signs the contract, whatever the price.

**Retainer and balance.** What customers pay at checkout and when the rest is due. Customers see these amounts at checkout and in their account. New bookings use any change. Signed contracts keep the numbers they were signed with.

- **Retainer (% of total).** The share paid up front to hold the date. 20 means a $1,000 booking pays a $200 retainer. Customers see this at checkout.
- **Balance due (days before the event).** 30 means the balance is due 30 days before the event. It's printed in new contracts and shown in the customer's account.
- **Small rentals pay at checkout.** What a small rental (no contract) pays when they book. Customers see this at checkout.
- **Save the card for the balance.** On: Stripe keeps the card used for the retainer so the balance can be charged later. Nothing is charged automatically yet.

**Cancellation and unpaid holds.** How long a customer can cancel for free, and when a held date with nothing paid is let go. The cancellation window shows at checkout and in contracts. Unpaid holds are checked every hour.

- **Free cancellation window (days before the event).** 5 means a customer can cancel for free until 5 days before the event. It's printed in the policy and in contracts, and shown at checkout.
- **Small rentals.** A date held on the store with no retainer paid is released after this many days, and the items free up. 0 means never.
- **Contract bookings.** Same rule for a booking whose contract is signed but whose retainer isn't paid. 0 means never.

**Limits and bot protection.** Stops the public store and Ask GO from running up costs or filling the calendar with junk. Customers only notice if a limit is hit. Counts start over at midnight Eastern.

- **Ask GO messages per day.** The most Ask GO replies the public can get in a day, all visitors together. Each reply costs real money. Past it, Ask GO asks people to call or text. Your team isn't limited.
- **Storefront bookings per day.** The most bookings the store can take in a day. Past it, customers are asked to call or text. Bookings you make aren't limited.
- **Require bot check on public forms.** On: forms that don't send the hidden bot-check fields are turned away. Turn it on only once the store sends them. Obvious bots are blocked either way.

### Contract and policy (`/settings/contract-and-policy`)

**Page line:** What customers agree to: the rental policy, the GO contract and the numbers in it, and who signs for GO.

**Rental policy.** The policy small-rental customers tick at checkout. Each save is a new version. Customers see the new version right away, and every booking keeps the version its customer agreed to.

- *Under the policy text.* You can drop in details that fill in for each booking: {{customer_name}}, {{event_date}}, {{event_time}}, {{event_address}}, {{total}}, {{deposit_percentage}} (a bare number, so type the % yourself), {{deposit_amount}} (the retainer), {{balance_amount}} and {{cancellation_window_days}}. Anything else in double braces stays as typed.

**Which contract new bookings get.** Switches between the GO contract and the older layout. Only bookings that need a contract are affected, and only new ones.

- **Use the GO contract for new bookings.** On: new bookings that need a contract get the three-page GO contract, with the wording below. Off: they get the older layout with the rental policy text. Contracts already sent don't change.

**GO contract wording.** The exact words of the GO contract. Each save is a new version. Contracts sent from now on use it. Contracts already sent or signed keep theirs.

- *Top of the editor.* Numbers come from your settings, so you don't type them. Put these in the wording and they fill in: {{retainerPercent}} {{lateCancellationDays}} {{balanceDueDays}} {{rescheduleFeePercent}} {{outsidePlannerChargePercent}} {{returnedCheckFee}}. Change a number in Settings and new contracts say the new number.
- *Header.* The title and the first lines at the top of page 1.
- *Pages 2 and 3.* The headings on the terms pages (2 and 3).
- *Clauses.* The numbered terms. Move them up or down, add more, or remove any.
- *Notes and acceptance.* The notes about services and payment, and the sign-here wording at the end.

**Contract numbers.** Numbers the contract wording uses. New contracts print the new numbers and signed ones don't change. The retainer, the balance due date and the cancellation window are set under Booking rules.

- **Sign and pay within (days of sending).** 7 means the contract header asks the customer to sign and pay within 7 days of getting it.
- **Returned check fee ($).** The dollar fee the contract charges if a check bounces. 50 means $50.
- **Reschedule fee (%).** The percentage the contract charges if a customer moves the date. 20 means 20%.
- **Outside planner charge (%).** The percentage the contract charges when a customer brings their own planner. 20 means 20%.

**Who signs for GO.** The name on GO's signature line, added when a contract is sent so customers see it already signed. Applies to contracts sent from now on.

- **Name.** The person who signs for GO. Example: Andy Caron.
- **Title.** Their title under the name. Example: Owner.
- *Under Name and Title, both filled in.* With both filled in, contracts show GO's signature next to the customer's. Leave both empty for no GO signature.
- *Under Name and Title, only one filled in.* Both are needed. With one empty, only the customer signs.

**Services table.** How booked items are sorted into the two columns of the services table on the contract. New contracts only. Signed ones don't change.

- *Top of the table.* Each row gathers items by category, by a word in the item's name, or by picking items. A booked item goes in the first row that wants it. Anything left over goes to Miscellaneous (services) or Rental Options (rentals).
- *Categories.* Pick the categories this row gathers.
- *Name words.* Items with any of these words in their name land in this row.
- *Specific items.* Pick specific items for this row.

### Messages and notifications (`/settings/notifications`)

**Page line:** Who your team alerts go to, when balance reminders start, and the columns leads move through.

**Staff alerts.** Where your team hears about signed contracts. Takes effect right away.

- **Staff alert phone.** Gets a text when a customer signs a contract. It's also the number crew see as the one to call.
- **Staff alert email.** Gets the signed contract link by email.

**Balance reminders.** Controls how early customers are reminded about an unpaid balance, and when your team sees "Balance due soon" in the bell. Takes effect right away.

- **Balance reminder window (days).** 7 means customers get balance reminders starting 7 days before the event, and your team is alerted when a balance falls due within 7 days.

**Daily digest.** One morning email to your team listing bell alerts nobody has read yet. It goes out at 7 AM Eastern.

- **Send the daily digest.** On: one email each morning when something from the last 24 hours is still unread.
- **Digest email.** Where the digest goes. Example: info@thegoeventgroup.com.

**Message wording.** The words of every automatic text and email, and which ones are switched on, are edited in Messages.

- *Button: Edit message templates.* Opens Messages, then Templates.

**Lead columns.** The stages a lead moves through on the Leads board, in order. New leads land in the first one. Your team sees a change right away.

- *Note about Booked and Lost.* The "Booked" column counts as won and the "Lost" column counts as lost. A lead in either one stops getting follow-up texts and emails, and so does any lead that has a booking. We find these two by name, so keep the names.

### Home photos (`/settings/home-photos`)

**Page line:** The photos that rotate at the top of the store's Home page.

**Photos.** Customers see these at the top of the Home page. A change shows on the store right away.

### Integrations (`/settings/integrations`)

**Page line:** Which outside services are connected, and how they're doing.

**Text messaging.** Every text to customers, crew and your team goes out through this. If it isn't set up, texts are logged as not sent.

**Email.** Every email to customers and your team goes out through this.

**Automatic messages.** Shows when the hourly check last ran, and whether any message failed all its tries.

**Online payment (Stripe).** Lets customers pay the retainer and balance by card at checkout.

**Address checking (Google Maps).** Checks that an address a customer types is a real street address. You can test one here.

**Google Calendar.** Puts every booking on your calendar, and can send the customer an invite. Only an Owner can connect it.

- *Before connecting.* Connect once with the Google account for info@thegoeventgroup.com. Every booking that reaches the stage you pick below goes on your calendar, and customers can get an invite. Changes made in Google don't come back into the admin.
- *GO calendar.* Where GO's own event for each booking goes. It lists crew, contacts and a link to the booking, and is never shared with customers.
- *Invites calendar.* A separate calendar, like "GO Client Invites", that customer invites are sent from. Customers only see the services, GO's phone and email, and their booking link.
- *Send calendar invites to customers.* On: Google emails the customer an invite, every update and any cancellation, using the email on the booking. Pick an invites calendar first.
- *Add bookings when they are.* Bookings go on the calendar at this stage. A booking that falls back below it (cancelled, released or moved back) is removed, and the customer gets Google's cancellation.

**Storefront.** The address of the store. Links in contracts and messages point here.

### Team (`/settings/team`)

**Page line:** Who can sign in to the admin, and what each person can do.

**People.** Owners can do everything, including this page and the business settings. Staff can do everything else. A change to someone's role or access takes effect right away.

**Invite someone.** Adds a new person. They get an email to set their own password.

**Recent changes.** A record of who changed settings and the team, and when.

### Text that was already there and is unchanged

- Home photos: "These photos rotate at the top of your store's Home page. Use wide, bright photos of real events. 3 to 6 works best."
- Integrations: the yes or no status lines, "Still needed" lines and "Last ..." lines inside each section.
- Team: the invite form labels and the table. The invite link note now reads "The link works once and expires after 72 hours."
- Lead columns: the column list itself and its own error messages.

<!-- copy:end -->
