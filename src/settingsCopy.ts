import type { AccountSettings } from "./lib/types";

// Block A12. Everything written on the Settings pages lives here: each
// page's intro, each section's one or two lines, and each field's label and
// help. The pages are drawn from this, and docs/SETTINGS-PLAN.md lists it
// from this (npm run settings:copy), so the wording reviewed is the wording
// shown. Written for Andy and Mel: plain words, no internal names.

export type FieldKind = "number" | "text" | "email" | "checkbox" | "select" | "occasions";
type Key = Exclude<keyof AccountSettings, "contractLogoSet">;

export type FieldSpec = {
  key: Key;
  label: string;
  help: string;
  kind: FieldKind;
  // text and email: an empty box saves as "not set" (null) instead of "".
  nullable?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  step?: string;
  maxLength?: number;
  placeholder?: string;
  options?: { value: string; label: string }[];
  // Consecutive fields with the same row sit side by side. groupLabel is the
  // line shown above that row.
  row?: string;
  groupLabel?: string;
};

export type PanelKey =
  | "logo"
  | "policy"
  | "terms"
  | "services"
  | "leadColumns"
  | "templatesLink"
  | "homePhotos"
  | "statusText"
  | "statusEmail"
  | "statusAutomation"
  | "statusStripe"
  | "statusMaps"
  | "googleCalendar"
  | "statusStorefront"
  | "people"
  | "invite"
  | "recentChanges";

export type SectionSpec = {
  id: string;
  title: string;
  blurb: string;
  fields?: FieldSpec[];
  panel?: PanelKey;
};

export type PageSpec = {
  id: string;
  title: string;
  path: string;
  intro: string;
  sections: SectionSpec[];
};

export const PAGES: PageSpec[] = [
  {
    id: "business",
    title: "Business",
    path: "/settings/business",
    intro: "Your business details, as customers see them on contracts, calendar invites, texts and emails.",
    sections: [
      {
        id: "company",
        title: "Company details",
        blurb: "These print on every contract and show on calendar invites. New contracts and invites use any change right away. Signed contracts don't change.",
        fields: [
          { key: "contractCompanyName", label: "Business name", kind: "text", required: true, help: "Printed at the top of contracts. Example: Go Event Group. Texts and emails say \"GO! Event Group\" and don't follow this box." },
          { key: "contractAddressLine", label: "Business address", kind: "text", required: true, help: "Printed on contracts. Example: 767 New Britain Ave, Farmington, Connecticut 06032." },
          { key: "contractPhone", label: "Phone on contracts", kind: "text", required: true, row: "phones", help: "Printed in the contract header. It doesn't change the number texts come from." },
          { key: "rushContactPhone", label: "Company phone (used in texts and emails)", kind: "text", nullable: true, maxLength: 40, row: "phones", placeholder: "Not set yet, e.g. (860) 555-0100", help: "The number customers are told to call or text in our texts and emails, on crew pages, and when they book on short notice. Leave it blank and we use the texting number." },
          { key: "contractEmail", label: "Business email", kind: "text", required: true, row: "web", help: "Printed on contracts and calendar invites. Example: info@thegoeventgroup.com." },
          { key: "contractWebsite", label: "Website", kind: "text", required: true, row: "web", help: "Printed on contracts. Example: www.thegoeventgroup.com." },
          { key: "contractFooterLine", label: "Footer on every contract page", kind: "text", required: true, help: "The small line at the bottom of each contract page. It's typed on its own, so change it too if your address or phone changes." },
        ],
      },
      {
        id: "logo",
        title: "Logo",
        blurb: "The picture at the top of contracts and their PDFs. New contracts use it right away. Signed contracts don't change.",
        panel: "logo",
      },
    ],
  },
  {
    id: "booking-rules",
    title: "Booking rules",
    path: "/settings/booking-rules",
    intro: "How bookings are made and paid on the store: who can book, what needs a contract, and what customers owe and when.",
    sections: [
      {
        id: "who-can-book",
        title: "Who can book online",
        blurb: "Controls who can hold a date on the store. Customers feel it at checkout, right away. Bookings you make in the admin are never blocked.",
        fields: [
          { key: "requireCustomerAccount", label: "Require an account to book", kind: "checkbox", help: "On: customers have to sign in or create an account before they can hold a date. Off: they can book as a guest." },
          { key: "requireAgreementCheckbox", label: "Require the rental policy checkbox", kind: "checkbox", help: "On: a booking without the ticked box is turned away. Off: it still goes through, marked \"box not ticked\". Turn this on once the store shows the checkbox." },
        ],
      },
      {
        id: "short-notice",
        title: "Short-notice bookings",
        blurb: "Marks bookings made close to the event so you can handle them differently. Customers see your company phone when they book inside this window. Applies to new bookings right away.",
        fields: [
          { key: "minBookingNoticeHours", label: "Short-notice window (hours)", kind: "number", min: 0, step: "1", required: true, help: "An event starting sooner than this is marked RUSH. It still goes through. 72 means anything within 3 days is rush. 0 turns it off." },
        ],
      },
      {
        id: "review-rules",
        title: "Review rules",
        blurb: "An order at or over the amount for its occasion goes to your team in Leads, under Storefront requests, before a date is held. The customer pays nothing yet and is told you'll be in touch. Under the amount, they check out and pay as normal. Applies to new orders right away.",
        fields: [
          { key: "reviewAmountWedding", label: "Wedding ($)", kind: "number", min: 0, step: "0.01", required: true, row: "r1", help: "5000 means a wedding order of $5,000 or more is reviewed, and a $4,999 one checks out online. Counts any Wedding occasion or a wedding package." },
          { key: "reviewAmountCorporate", label: "Corporate ($)", kind: "number", min: 0, step: "0.01", required: true, row: "r1", help: "5000 means a corporate order of $5,000 or more is reviewed. Smaller ones check out online." },
          { key: "reviewAmountKids", label: "Kids party ($)", kind: "number", min: 0, step: "0.01", required: true, row: "r2", help: "10000 means a kids party order of $10,000 or more is reviewed." },
          { key: "reviewAmountAdult", label: "Adult party ($)", kind: "number", min: 0, step: "0.01", required: true, row: "r2", help: "10000 means an adult party order of $10,000 or more is reviewed." },
          { key: "reviewAmountDefault", label: "Everything else ($)", kind: "number", min: 0, step: "0.01", required: true, row: "r3", help: "Used when an order has no occasion. 10000 means $10,000 or more is reviewed." },
          { key: "requestResponseDays", label: "Contact the customer within (business days)", kind: "number", min: 1, max: 30, step: "1", required: true, row: "r3", help: "3 means customers in review are told \"We will contact you within 3 business days\". A request still open after that raises a bell alert every day until it's handled." },
        ],
      },
      {
        id: "contracts",
        title: "Contracts and checkout",
        blurb: "Decides what a customer signs at checkout: the rental policy checkbox for small rentals, or the GO contract for bigger or crewed bookings. Applies to new bookings right away.",
        fields: [
          { key: "contractRequiredOver", label: "Contract required over ($)", kind: "number", min: 0, step: "0.01", required: true, help: "A booking with a total above this signs the GO contract at checkout. 1000 means $1,001 needs a contract and $1,000 only needs the checkbox." },
          { key: "contractRequiredForCrewed", label: "Contract required for crewed items", kind: "checkbox", help: "On: anything that needs crew, like a DJ or a photographer, always signs the contract, whatever the price." },
        ],
      },
      {
        id: "payment",
        title: "Retainer and balance",
        blurb: "What customers pay at checkout and when the rest is due. Customers see these amounts at checkout and in their account. New bookings use any change. Signed contracts keep the numbers they were signed with.",
        fields: [
          { key: "depositPercentage", label: "Retainer (% of total)", kind: "number", min: 0, max: 100, step: "0.01", required: true, row: "retainer", help: "The share paid up front to hold the date. 20 means a $1,000 booking pays a $200 retainer. Customers see this at checkout." },
          { key: "balanceDueDays", label: "Balance due (days before the event)", kind: "number", min: 0, step: "1", required: true, row: "retainer", help: "30 means the balance is due 30 days before the event. It's printed in new contracts and shown in the customer's account." },
          { key: "tier1Collect", label: "Small rentals pay at checkout", kind: "select", options: [{ value: "retainer", label: "The retainer" }, { value: "full", label: "The full amount" }], help: "What a small rental (no contract) pays when they book. Customers see this at checkout." },
          { key: "saveCardForBalance", label: "Save the card for the balance", kind: "checkbox", help: "On: Stripe keeps the card used for the retainer so the balance can be charged later. Nothing is charged automatically yet." },
        ],
      },
      {
        id: "retainer-reminders",
        title: "Retainer reminders",
        blurb: "When a customer has been asked for the retainer and hasn't paid, they get up to three reminders by text and email, each with their pay link and the amount. The days count from the first time they were asked. Reminders stop the moment the retainer is paid or the booking is cancelled. The day after the last one, you get a bell alert, \"Retainer still unpaid\". The wording is in Messages, Templates. A change applies to reminders that haven't gone yet.",
        fields: [
          { key: "retainerReminderDay1", label: "First reminder (days after)", kind: "number", min: 0, max: 60, step: "1", required: true, row: "rr", help: "1 means the day after they were first asked, at 10 AM. 0 switches this reminder off." },
          { key: "retainerReminderDay2", label: "Second reminder (days after)", kind: "number", min: 0, max: 60, step: "1", required: true, row: "rr", help: "3 means three days after they were first asked. 0 switches this reminder off." },
          { key: "retainerReminderDay3", label: "Last reminder (days after)", kind: "number", min: 0, max: 60, step: "1", required: true, row: "rr", help: "7 means a week after they were first asked. 0 switches this reminder off." },
          { key: "holdReminderEmails", label: "Email customers who hold a date in the store and don't pay", kind: "checkbox", help: "On: a signed-in customer who holds a date for a small rental and leaves without paying the retainer gets an email with their pay link 1 day and 3 days later. Email only, never a text, and only for customers with an account. Off: they get nothing. The wording is \"Unpaid hold reminder\" in Messages, Templates." },
        ],
      },
      {
        id: "cancellation-holds",
        title: "Cancellation and unpaid holds",
        blurb: "How long a customer can cancel for free, and when a held date with nothing paid is let go. The cancellation window shows at checkout and in contracts. Unpaid holds are checked every hour.",
        fields: [
          { key: "cancellationWindowDays", label: "Free cancellation window (days before the event)", kind: "number", min: 0, max: 365, step: "1", required: true, help: "5 means a customer can cancel for free until 5 days before the event. It's printed in the policy and in contracts, and shown at checkout." },
          { key: "holdReleaseDays", label: "Small rentals", kind: "number", min: 0, max: 365, step: "1", required: true, row: "holds", groupLabel: "Let go of unpaid holds after (days)", help: "A date held on the store with no retainer paid is released after this many days, and the items free up. 0 means never." },
          { key: "contractHoldReleaseDays", label: "Contract bookings", kind: "number", min: 0, max: 365, step: "1", required: true, row: "holds", help: "Same rule for a booking whose contract is signed but whose retainer isn't paid. 0 means never." },
        ],
      },
      {
        id: "limits",
        title: "Limits and bot protection",
        blurb: "Stops the public store and Ask GO from running up costs or filling the calendar with junk. Customers only notice if a limit is hit. Counts start over at midnight Eastern.",
        fields: [
          { key: "aiDailyCap", label: "Ask GO messages per day", kind: "number", min: 0, max: 100000, step: "1", required: true, row: "caps", help: "The most Ask GO replies the public can get in a day, all visitors together. Each reply costs real money. Past it, Ask GO asks people to call or text. Your team isn't limited." },
          { key: "directBookingDailyCap", label: "Storefront bookings per day", kind: "number", min: 0, max: 10000, step: "1", required: true, row: "caps", help: "The most bookings the store can take in a day. Past it, customers are asked to call or text. Bookings you make aren't limited." },
          { key: "requireBotCheck", label: "Require bot check on public forms", kind: "checkbox", help: "On: forms that don't send the hidden bot-check fields are turned away. Turn it on only once the store sends them. Obvious bots are blocked either way." },
        ],
      },
    ],
  },
  {
    id: "contract-and-policy",
    title: "Contract and policy",
    path: "/settings/contract-and-policy",
    intro: "What customers agree to: the rental policy, the GO contract and the numbers in it, and who signs for GO.",
    sections: [
      {
        id: "rental-policy",
        title: "Rental policy",
        blurb: "The policy small-rental customers tick at checkout. Each save is a new version. Customers see the new version right away, and every booking keeps the version its customer agreed to.",
        panel: "policy",
      },
      {
        id: "which-contract",
        title: "Which contract new bookings get",
        blurb: "Switches between the GO contract and the older layout. Only bookings that need a contract are affected, and only new ones.",
        fields: [
          { key: "useGoContract", label: "Use the GO contract for new bookings", kind: "checkbox", help: "On: new bookings that need a contract get the three-page GO contract, with the wording below. Off: they get the older layout with the rental policy text. Contracts already sent don't change." },
        ],
      },
      {
        id: "wording",
        title: "GO contract wording",
        blurb: "The exact words of the GO contract. Each save is a new version. Contracts sent from now on use it. Contracts already sent or signed keep theirs.",
        panel: "terms",
      },
      {
        id: "numbers",
        title: "Contract numbers",
        blurb: "Numbers the contract wording uses. New contracts print the new numbers and signed ones don't change. The retainer, the balance due date and the cancellation window are set under Booking rules.",
        fields: [
          { key: "signAndPayWindowDays", label: "Sign and pay within (days of sending)", kind: "number", min: 0, step: "1", required: true, row: "n1", help: "7 means the contract header asks the customer to sign and pay within 7 days of getting it." },
          { key: "returnedCheckFee", label: "Returned check fee ($)", kind: "number", min: 0, step: "0.01", required: true, row: "n1", help: "The dollar fee the contract charges if a check bounces. 50 means $50." },
          { key: "rescheduleFeePercent", label: "Reschedule fee (%)", kind: "number", min: 0, step: "0.01", required: true, row: "n2", help: "The percentage the contract charges if a customer moves the date. 20 means 20%." },
          { key: "outsidePlannerChargePercent", label: "Outside planner charge (%)", kind: "number", min: 0, step: "0.01", required: true, row: "n2", help: "The percentage the contract charges when a customer brings their own planner. 20 means 20%." },
        ],
      },
      {
        id: "signer",
        title: "Who signs for GO",
        blurb: "The name on GO's signature line, added when a contract is sent so customers see it already signed. Applies to contracts sent from now on.",
        fields: [
          { key: "authorizedSignerName", label: "Name", kind: "text", nullable: true, maxLength: 120, row: "signer", placeholder: "Andy Caron", help: "The person who signs for GO. Example: Andy Caron." },
          { key: "authorizedSignerTitle", label: "Title", kind: "text", nullable: true, maxLength: 120, row: "signer", placeholder: "Owner", help: "Their title under the name. Example: Owner." },
        ],
      },
      {
        id: "services",
        title: "Services table",
        blurb: "How booked items are sorted into the two columns of the services table on the contract. New contracts only. Signed ones don't change.",
        panel: "services",
      },
    ],
  },
  {
    id: "notifications",
    title: "Messages and notifications",
    path: "/settings/notifications",
    intro: "Who your team alerts go to, when balance reminders start, and the columns leads move through.",
    sections: [
      {
        id: "staff-alerts",
        title: "Staff alerts",
        blurb: "Where your team hears about signed contracts. Takes effect right away.",
        fields: [
          { key: "staffNotifyPhone", label: "Staff alert phone", kind: "text", nullable: true, maxLength: 200, row: "alerts", placeholder: "(860) 555-0100", help: "Gets a text when a customer signs a contract. It's also the number crew see as the one to call." },
          { key: "staffNotifyEmail", label: "Staff alert email", kind: "email", nullable: true, maxLength: 200, row: "alerts", placeholder: "andy@example.com", help: "Gets the signed contract link by email." },
        ],
      },
      {
        id: "reminders",
        title: "Balance reminders",
        blurb: "Controls how early customers are reminded about an unpaid balance, and when your team sees \"Balance due soon\" in the bell. Takes effect right away.",
        fields: [
          { key: "balanceReminderWindowDays", label: "Balance reminder window (days)", kind: "number", min: 0, max: 120, step: "1", required: true, help: "7 means customers get balance reminders starting 7 days before the event, and your team is alerted when a balance falls due within 7 days." },
        ],
      },
      {
        id: "digest",
        title: "Daily digest",
        blurb: "One morning email to your team listing bell alerts nobody has read yet. It goes out at 7 AM Eastern.",
        fields: [
          { key: "digestEnabled", label: "Send the daily digest", kind: "checkbox", help: "On: one email each morning when something from the last 24 hours is still unread." },
          { key: "digestEmail", label: "Digest email", kind: "email", required: true, maxLength: 200, help: "Where the digest goes. Example: info@thegoeventgroup.com." },
        ],
      },
      {
        id: "templates",
        title: "Message wording",
        blurb: "The words of every automatic text and email, and which ones are switched on, are edited in Messages.",
        panel: "templatesLink",
      },
      {
        id: "lead-columns",
        title: "Lead columns",
        blurb: "The stages a lead moves through on the Leads board, in order. New leads land in the first one. Your team sees a change right away.",
        panel: "leadColumns",
      },
    ],
  },
  {
    id: "home-photos",
    title: "Home photos",
    path: "/settings/home-photos",
    intro: "The photos that rotate at the top of the store's Home page.",
    sections: [
      {
        id: "photos",
        title: "Photos",
        blurb: "Customers see these at the top of the Home page. A change shows on the store right away.",
        panel: "homePhotos",
      },
    ],
  },
  {
    id: "integrations",
    title: "Integrations",
    path: "/settings/integrations",
    intro: "Which outside services are connected, and how they're doing.",
    sections: [
      { id: "texting", title: "Text messaging", blurb: "Every text to customers, crew and your team goes out through this. If it isn't set up, texts are logged as not sent.", panel: "statusText" },
      { id: "email", title: "Email", blurb: "Every email to customers and your team goes out through this.", panel: "statusEmail" },
      { id: "automation", title: "Automatic messages", blurb: "Shows when the hourly check last ran, and whether any message failed all its tries.", panel: "statusAutomation" },
      { id: "payments", title: "Online payment (Stripe)", blurb: "Lets customers pay the retainer and balance by card at checkout.", panel: "statusStripe" },
      { id: "maps", title: "Address checking (Google Maps)", blurb: "Checks that an address a customer types is a real street address. You can test one here.", panel: "statusMaps" },
      { id: "calendar", title: "Google Calendar", blurb: "Puts every booking on your calendar, and can send the customer an invite. Only an Owner can connect it.", panel: "googleCalendar" },
      { id: "storefront", title: "Storefront", blurb: "The address of the store. Links in contracts and messages point here.", panel: "statusStorefront" },
      {
        id: "pay-links",
        title: "Pay links",
        blurb: "Where the pay link in a text or an email takes the customer. Leave this off until the store's own pay page is live.",
        fields: [
          { key: "payLinksOpenStorefront", label: "Pay links open the storefront pay page", kind: "checkbox", help: "Off: a pay link opens this admin's address and goes straight to the secure Stripe payment page. On: pay links in new messages open the store's own page at /pay instead. Links already sent keep working either way. Applies to the next message sent." },
        ],
      },
    ],
  },
  {
    id: "team",
    title: "Team",
    path: "/settings/team",
    intro: "Who can sign in to the admin, and what each person can do.",
    sections: [
      { id: "people", title: "People", blurb: "Owners can do everything, including this page and the business settings. Staff can do everything else. A change to someone's role or access takes effect right away.", panel: "people" },
      { id: "invite", title: "Invite someone", blurb: "Adds a new person. They get an email to set their own password.", panel: "invite" },
      { id: "recent", title: "Recent changes", blurb: "A record of who changed settings and the team, and when.", panel: "recentChanges" },
    ],
  },
];

export const pageById = (id: string): PageSpec => {
  const p = PAGES.find((x) => x.id === id);
  if (!p) throw new Error(`No settings page ${id}`);
  return p;
};

// Wording used inside the bigger editors, kept here so the plan lists it.
export const EDITOR_COPY = {
  logo: {
    help: "Drop a picture on the box or pick one from your computer.",
    inUse: "Your own logo is in use.",
    placeholder: "The built-in placeholder is in use until you add a logo.",
  },
  policy: {
    help: "You can drop in details that fill in for each booking: {{customer_name}}, {{event_date}}, {{event_time}}, {{event_address}}, {{total}}, {{deposit_percentage}} (a bare number, so type the % yourself), {{deposit_amount}} (the retainer), {{balance_amount}} and {{cancellation_window_days}}. Anything else in double braces stays as typed.",
  },
  terms: {
    help: "Numbers come from your settings, so you don't type them. Put these in the wording and they fill in: {{retainerPercent}} {{lateCancellationDays}} {{balanceDueDays}} {{rescheduleFeePercent}} {{outsidePlannerChargePercent}} {{returnedCheckFee}}. Change a number in Settings and new contracts say the new number.",
    header: "The title and the first lines at the top of page 1.",
    pages: "The headings on the terms pages (2 and 3).",
    clauses: "The numbered terms. Move them up or down, add more, or remove any.",
    notes: "The notes about services and payment, and the sign-here wording at the end.",
  },
  services: {
    help: "Each row gathers items by category, by a word in the item's name, or by picking items. A booked item goes in the first row that wants it. Anything left over goes to Miscellaneous (services) or Rental Options (rentals).",
    categories: "Pick the categories this row gathers.",
    words: "Items with any of these words in their name land in this row.",
    items: "Pick specific items for this row.",
  },
  leadColumns: {
    note: "The \"Booked\" column counts as won and the \"Lost\" column counts as lost. A lead in either one stops getting follow-up texts and emails, and so does any lead that has a booking. We find these two by name, so keep the names.",
  },
  signer: {
    half: "Both are needed. With one empty, only the customer signs.",
    ok: "With both filled in, contracts show GO's signature next to the customer's. Leave both empty for no GO signature.",
  },
  google: {
    connect: "Connect once with the Google account for info@thegoeventgroup.com. Every booking that reaches the stage you pick below goes on your calendar, and customers can get an invite. Changes made in Google don't come back into the admin.",
    internal: "Where GO's own event for each booking goes. It lists crew, contacts and a link to the booking, and is never shared with customers.",
    invites: "A separate calendar, like \"GO Client Invites\", that customer invites are sent from. Customers only see the services, GO's phone and email, and their booking link.",
    sendInvites: "On: Google emails the customer an invite, every update and any cancellation, using the email on the booking. Pick an invites calendar first.",
    stage: "Bookings go on the calendar at this stage. A booking that falls back below it (cancelled, released or moved back) is removed, and the customer gets Google's cancellation.",
  },
  templatesLink: { button: "Edit message templates", help: "Opens Messages, then Templates." },
} as const;
