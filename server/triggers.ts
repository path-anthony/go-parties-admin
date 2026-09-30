// The trigger registry: the single source of truth for every automated
// message. Adding a message to the system means adding it here. Each entry
// says who it is for, what kind of send it is (which decides when it may
// go), when it fires and when it stops, which merge tokens it may use, and
// its default wording. Wording the admin customizes lives in
// message_templates and overrides these defaults; deleting the row goes
// back to what is written here.
//
// Voice (docs/BRAND.md section 10): short sentences, verbs first, no
// exclamation points of our own, no em dashes, none of the banned words.
// The company name is a token because its spelling includes a "!".
//
// wired: whether anything in the app fires this trigger today. Triggers
// that are not wired are registered so they can be written and switched
// on or off now; the scheduler (Block 2), the cart and hold capture, and
// bidding (Block 3) are what will fire them.

export type Journey = "lead" | "client" | "crew";
export type SendClass = "transactional" | "reminder" | "nurture";
export type Channel = "sms" | "email";

export type TriggerDef = {
  key: string;
  journey: Journey;
  sendClass: SendClass;
  label: string;
  when: string;
  stopsWhen: string;
  tokens: string[];
  sms: string;
  emailSubject: string;
  emailBody: string;
  wired: boolean;
  // Why it isn't wired yet, shown in the admin.
  unwiredReason?: string;
  // Anything the admin should know about how it behaves today.
  note?: string;
  // Texts are on by default for every trigger. Email is off unless the app
  // already sent that email before the pipeline existed, so the pipeline
  // changes nothing until someone turns a channel on.
  emailDefaultOn?: boolean;
};

const STOP = " Reply STOP to opt out.";
const SIGN = "\n\n{{companyName}}";

// Grouped for readability; TRIGGERS at the bottom is the list.
const lead: TriggerDef[] = [
  {
    key: "lead_new_ack",
    journey: "lead",
    sendClass: "transactional",
    label: "New lead: we got your request",
    when: "Right after someone enters an inquiry with a phone number, from inside this app.",
    stopsWhen: "It sends once per lead.",
    tokens: ["customerFirstName", "companyName", "companyPhone"],
    sms: "Hi {{customerFirstName}}, this is {{companyName}}. We got your request and a person will reach out soon. Need us sooner? Call or text {{companyPhone}}.",
    emailSubject: "We got your request",
    emailBody: "Hi {{customerFirstName}},\n\nWe got your request and a person will reach out soon. Need us sooner? Call or text {{companyPhone}}." + SIGN,
    wired: false,
    unwiredReason: "Waiting on the scheduler and lead rules in Block 2.",
  },
  {
    key: "lead_cart_abandoned_1h",
    journey: "lead",
    sendClass: "nurture",
    label: "Cart left behind, 1 hour",
    when: "One hour after someone builds a cart and leaves without holding a date.",
    stopsWhen: "They hold a date, reply STOP, or the lead is closed.",
    tokens: ["customerFirstName", "eventType", "cartLink", "companyName"],
    sms: "Hi {{customerFirstName}}, your {{eventType}} cart is still saved with {{companyName}}. Pick it back up: {{cartLink}}" + STOP,
    emailSubject: "Your cart is still saved",
    emailBody: "Hi {{customerFirstName}},\n\nYour {{eventType}} cart is still saved. Pick it back up: {{cartLink}}" + SIGN,
    wired: false,
    unwiredReason: "The storefront does not save carts on the server yet, so there is nothing to detect.",
  },
  {
    key: "lead_cart_abandoned_24h",
    journey: "lead",
    sendClass: "nurture",
    label: "Cart left behind, 24 hours",
    when: "A day after someone builds a cart and leaves without holding a date.",
    stopsWhen: "They hold a date, reply STOP, or the lead is closed.",
    tokens: ["customerFirstName", "eventDate", "cartLink", "companyName"],
    sms: "Hi {{customerFirstName}}, dates fill up. Check that {{eventDate}} is still open and finish your cart: {{cartLink}}" + STOP,
    emailSubject: "Is {{eventDate}} still your date?",
    emailBody: "Hi {{customerFirstName}},\n\nDates fill up. Check that {{eventDate}} is still open and finish your cart: {{cartLink}}" + SIGN,
    wired: false,
    unwiredReason: "The storefront does not save carts on the server yet, so there is nothing to detect.",
  },
  {
    key: "lead_hold_expiring",
    journey: "lead",
    sendClass: "transactional",
    label: "Hold about to expire",
    when: "Shortly before a held date is released because the contract is unsigned.",
    stopsWhen: "The contract is signed, or the hold is released.",
    tokens: ["customerFirstName", "eventDate", "holdExpiresAt", "contractLink"],
    sms: "Hi {{customerFirstName}}, your hold on {{eventDate}} ends {{holdExpiresAt}}. Sign to keep it: {{contractLink}}",
    emailSubject: "Your hold on {{eventDate}} ends soon",
    emailBody: "Hi {{customerFirstName}},\n\nYour hold on {{eventDate}} ends {{holdExpiresAt}}. Sign to keep it: {{contractLink}}" + SIGN,
    wired: false,
    unwiredReason: "Holds do not expire in this app yet, so there is no expiry time to send.",
  },
  {
    key: "lead_nurture_day3",
    journey: "lead",
    sendClass: "nurture",
    label: "Follow up, day 3",
    when: "Three days after a lead was entered by hand, at 10 AM Eastern (Monday if that is a Sunday). Website and storefront leads never get it.",
    stopsWhen: "They book, reply, reply STOP, or the lead is closed.",
    tokens: ["customerFirstName", "eventType", "companyName", "companyPhone"],
    sms: "Hi {{customerFirstName}}, still planning your {{eventType}}? Reply with your date and we'll check what's open. {{companyName}}." + STOP,
    emailSubject: "Still planning your {{eventType}}?",
    emailBody: "Hi {{customerFirstName}},\n\nStill planning your {{eventType}}? Reply with your date and we'll check what's open. You can also call or text {{companyPhone}}." + SIGN,
    wired: true,
  },
  {
    key: "lead_nurture_day10",
    journey: "lead",
    sendClass: "nurture",
    label: "Follow up, day 10",
    when: "Ten days after a lead was entered by hand, at 10 AM Eastern (Monday if that is a Sunday). Website and storefront leads never get it.",
    stopsWhen: "They book, reply, reply STOP, or the lead is closed.",
    tokens: ["customerFirstName", "eventType", "companyName"],
    sms: "Hi {{customerFirstName}}, last note from {{companyName}}. If your {{eventType}} is still on, text us your date and we'll hold it while you decide." + STOP,
    emailSubject: "Your {{eventType}}, one last check",
    emailBody: "Hi {{customerFirstName}},\n\nLast note from us. If your {{eventType}} is still on, reply with your date and we'll hold it while you decide." + SIGN,
    wired: true,
  },
  {
    key: "lead_concierge_ack",
    journey: "lead",
    sendClass: "transactional",
    label: "Concierge call booked",
    when: "After someone books a call with the team and we have their phone number.",
    stopsWhen: "It sends once per request.",
    tokens: ["customerFirstName", "companyName", "companyPhone"],
    sms: "Hi {{customerFirstName}}, your call with {{companyName}} is on the calendar. Need to change it? Text {{companyPhone}}.",
    emailSubject: "Your call is on the calendar",
    emailBody: "Hi {{customerFirstName}},\n\nYour call is on the calendar. Need to change it? Text {{companyPhone}}." + SIGN,
    wired: false,
    unwiredReason: "Concierge requests carry no name or phone (Calendly collects them), so there is no one to text yet.",
  },
];

const client: TriggerDef[] = [
  {
    key: "contract_sent",
    journey: "client",
    sendClass: "transactional",
    label: "Contract ready to sign",
    when: "When the contract is sent: a request is turned into a booking, staff set the stage to Contract Sent, or staff press Send contract link.",
    stopsWhen: "It sends once per booking, unless staff send it again by hand.",
    tokens: ["customerFirstName", "companyName", "eventDate", "contractLink"],
    sms: "Hi {{customerFirstName}}, your {{companyName}} contract for {{eventDate}} is ready to review and sign: {{contractLink}}",
    emailSubject: "Your {{companyName}} contract is ready",
    emailBody: "Hi {{customerFirstName}},\n\nYour contract for {{eventDate}} is ready to review and sign: {{contractLink}}" + SIGN,
    wired: true,
    emailDefaultOn: true,
  },
  {
    key: "contract_signed",
    journey: "client",
    sendClass: "transactional",
    label: "Contract signed, here is your copy",
    when: "When the customer signs their contract online.",
    stopsWhen: "It sends once per booking.",
    tokens: ["customerFirstName", "companyName", "eventDate", "contractPdfLink"],
    sms: "Thanks {{customerFirstName}}, your {{companyName}} contract for {{eventDate}} is signed. Your copy: {{contractPdfLink}}",
    emailSubject: "Your signed {{companyName}} contract",
    emailBody: "Hi {{customerFirstName}},\n\nThanks for signing. Your signed contract for {{eventDate}} is at the link below. Keep it for your records.\n\n{{contractPdfLink}}" + SIGN,
    wired: true,
    emailDefaultOn: true,
  },
  {
    key: "contract_signed_recorded",
    journey: "client",
    sendClass: "transactional",
    label: "Signed contract on file (set by staff)",
    when: "When staff set the stage to Signed themselves, for example after a paper signature.",
    stopsWhen: "It sends once per booking.",
    tokens: ["customerFirstName", "eventDate"],
    sms: "Thanks {{customerFirstName}}, we have your signed contract for {{eventDate}}. The next step is the retainer payment to confirm your date.",
    emailSubject: "We have your signed contract",
    emailBody: "Hi {{customerFirstName}},\n\nWe have your signed contract for {{eventDate}}. The next step is the retainer payment to confirm your date." + SIGN,
    wired: true,
  },
  {
    key: "retainer_paid",
    journey: "client",
    sendClass: "transactional",
    label: "Retainer received",
    when: "When staff mark the retainer paid.",
    stopsWhen: "It sends once per booking.",
    tokens: ["customerFirstName", "eventDate", "companyName"],
    sms: "Hi {{customerFirstName}}, we received your retainer for {{eventDate}}. Thank you. Your date is confirmed once the contract is signed too.",
    emailSubject: "We received your retainer",
    emailBody: "Hi {{customerFirstName}},\n\nWe received your retainer for {{eventDate}}. Thank you. Your date is confirmed once the contract is signed too." + SIGN,
    wired: true,
    emailDefaultOn: true,
  },
  {
    key: "booking_confirmed",
    journey: "client",
    sendClass: "transactional",
    label: "Booking confirmed",
    when: "When a booking is both signed and paid, whichever comes last.",
    stopsWhen: "It sends once per booking.",
    tokens: ["customerFirstName", "companyName", "eventDate"],
    sms: "Hi {{customerFirstName}}, your {{companyName}} booking for {{eventDate}} is confirmed. We're looking forward to your event.",
    emailSubject: "Your booking is confirmed",
    emailBody: "Hi {{customerFirstName}},\n\nYour booking for {{eventDate}} is confirmed. We're looking forward to your event." + SIGN,
    wired: true,
    emailDefaultOn: true,
  },
  {
    key: "booking_cancelled",
    journey: "client",
    sendClass: "transactional",
    label: "Booking cancelled",
    when: "When staff cancel a booking.",
    stopsWhen: "It sends once per booking.",
    tokens: ["customerFirstName", "companyName", "eventDate"],
    sms: "Hi {{customerFirstName}}, your {{companyName}} booking for {{eventDate}} has been cancelled. If that doesn't look right, please call or text us.",
    emailSubject: "Your booking was cancelled",
    emailBody: "Hi {{customerFirstName}},\n\nYour booking for {{eventDate}} has been cancelled. If that doesn't look right, please call or text us." + SIGN,
    wired: true,
  },
  {
    key: "staff_contract_signed",
    journey: "client",
    sendClass: "transactional",
    label: "Staff heads-up: contract signed",
    when: "When a customer signs. Goes to the staff phone and email set under Notifications, not to the customer.",
    stopsWhen: "It sends once per booking.",
    tokens: ["customerName", "eventDate", "contractPdfLink"],
    sms: "Signed: {{customerName}} signed the contract for {{eventDate}}. {{contractPdfLink}}",
    emailSubject: "Contract signed: {{customerName}}, {{eventDate}}",
    emailBody: "{{customerName}} signed the contract for {{eventDate}}. {{contractPdfLink}}\n\nSigned copy: {{contractPdfLink}}",
    wired: true,
    emailDefaultOn: true,
  },
  {
    key: "contract_unsigned_nudge",
    journey: "client",
    sendClass: "reminder",
    label: "Contract still unsigned",
    when: "48 hours after the signing link went out, if it is still unsigned.",
    stopsWhen: "The contract is signed or the booking is cancelled.",
    tokens: ["customerFirstName", "eventDate", "contractLink", "companyName"],
    sms: "Hi {{customerFirstName}}, your contract for {{eventDate}} still needs your signature. Sign here: {{contractLink}}",
    emailSubject: "Your contract still needs a signature",
    emailBody: "Hi {{customerFirstName}},\n\nYour contract for {{eventDate}} still needs your signature. Sign here: {{contractLink}}" + SIGN,
    wired: true,
    emailDefaultOn: true,
  },
  {
    key: "balance_due_reminder",
    journey: "client",
    sendClass: "reminder",
    label: "Balance due soon",
    when: "When the retainer is paid, the balance is not, and the event is inside the reminder window (Settings, Notifications).",
    stopsWhen: "Staff mark the balance paid, or the booking is cancelled.",
    tokens: ["customerFirstName", "balanceDue", "companyName", "eventDate"],
    sms: "Hi {{customerFirstName}}, a reminder that the remaining balance of {{balanceDue}} for your {{companyName}} event on {{eventDate}} is coming due. Please call or text us to arrange payment.",
    emailSubject: "Your balance is coming due",
    emailBody: "Hi {{customerFirstName}},\n\nA reminder that the remaining balance of {{balanceDue}} for your event on {{eventDate}} is coming due. Please call or text us to arrange payment." + SIGN,
    wired: true,
    emailDefaultOn: true,
  },
  {
    key: "event_week_reminder",
    journey: "client",
    sendClass: "reminder",
    label: "Event is a week away",
    when: "About 7 days before the event.",
    stopsWhen: "The event happens or the booking is cancelled.",
    tokens: ["customerFirstName", "eventDate", "daysUntilEvent", "eventAddress", "portalLink"],
    sms: "Hi {{customerFirstName}}, your event is {{daysUntilEvent}} days out, on {{eventDate}}. Check the details and text us any changes: {{portalLink}}",
    emailSubject: "Your event is {{daysUntilEvent}} days away",
    emailBody: "Hi {{customerFirstName}},\n\nYour event is {{daysUntilEvent}} days out, on {{eventDate}}, at {{eventAddress}}. Check the details and text us any changes: {{portalLink}}" + SIGN,
    wired: true,
    emailDefaultOn: true,
  },
  {
    key: "event_eve_reminder",
    journey: "client",
    sendClass: "reminder",
    label: "Event is tomorrow",
    when: "The day before the event.",
    stopsWhen: "The event happens or the booking is cancelled.",
    tokens: ["customerFirstName", "eventDate", "eventAddress", "companyPhone"],
    sms: "Hi {{customerFirstName}}, your event is tomorrow, {{eventDate}}. Confirm the address is {{eventAddress}} and the setup area is clear. Changes? Text {{companyPhone}}.",
    emailSubject: "Your event is tomorrow",
    emailBody: "Hi {{customerFirstName}},\n\nYour event is tomorrow, {{eventDate}}. Confirm the address is {{eventAddress}} and the setup area is clear. Changes? Text {{companyPhone}}." + SIGN,
    wired: true,
    emailDefaultOn: true,
  },
  {
    key: "post_event_thanks",
    journey: "client",
    sendClass: "reminder",
    label: "Thanks after the event",
    when: "The day after the event.",
    stopsWhen: "It sends once per booking.",
    tokens: ["customerFirstName", "companyName", "portalLink"],
    sms: "Hi {{customerFirstName}}, thanks for having {{companyName}} at your event. Tell us how it went, or plan the next one: {{portalLink}}",
    emailSubject: "Thanks for having us",
    emailBody: "Hi {{customerFirstName}},\n\nThanks for having us at your event. Tell us how it went, or plan the next one: {{portalLink}}" + SIGN,
    wired: true,
    emailDefaultOn: true,
  },
];

const crew: TriggerDef[] = [
  {
    key: "gig_bid_invite",
    journey: "crew",
    sendClass: "transactional",
    label: "Gig offered to crew",
    when: "When staff send a gig offer to a crew member.",
    stopsWhen: "It sends once per person per gig.",
    tokens: ["crewFirstName", "companyName", "gigRole", "gigItemName", "gigDate"],
    sms: "Hi {{crewFirstName}}, {{companyName}} has a {{gigRole}} gig for {{gigItemName}} on {{gigDate}}. Can you take it? Please call or text us back to say yes or no.",
    emailSubject: "A {{gigRole}} gig on {{gigDate}}",
    emailBody: "Hi {{crewFirstName}},\n\n{{companyName}} has a {{gigRole}} gig for {{gigItemName}} on {{gigDate}}. Can you take it? Please call or text us back to say yes or no." + SIGN,
    wired: true,
  },
  {
    key: "bid_accepted",
    journey: "crew",
    sendClass: "transactional",
    label: "Your bid was accepted",
    when: "When staff pick a crew member's bid.",
    stopsWhen: "It sends once per person per gig.",
    tokens: ["crewFirstName", "gigRole", "gigDate", "gigStartTime", "gigAddress", "bidAmount", "gigLink"],
    sms: "Hi {{crewFirstName}}, you got the {{gigRole}} gig on {{gigDate}}, {{gigStartTime}}, at {{gigAddress}}. Pay: {{bidAmount}}. Details and confirmation: {{gigLink}}",
    emailSubject: "You got the {{gigRole}} gig on {{gigDate}}",
    emailBody: "Hi {{crewFirstName}},\n\nYou got the {{gigRole}} gig on {{gigDate}}, {{gigStartTime}}, at {{gigAddress}}. Pay: {{bidAmount}}.\n\nDetails and confirmation: {{gigLink}}" + SIGN,
    wired: false,
    unwiredReason: "Bidding arrives in Block 3.",
  },
  {
    key: "bid_not_selected",
    journey: "crew",
    sendClass: "transactional",
    label: "Bid not selected",
    when: "When staff pick someone else for a gig this crew member bid on.",
    stopsWhen: "It sends once per person per gig.",
    tokens: ["crewFirstName", "gigRole", "gigDate", "companyName"],
    sms: "Hi {{crewFirstName}}, thanks for bidding on the {{gigRole}} gig on {{gigDate}}. We went another way this time. We'll send the next one your way.",
    emailSubject: "About the {{gigRole}} gig on {{gigDate}}",
    emailBody: "Hi {{crewFirstName}},\n\nThanks for bidding on the {{gigRole}} gig on {{gigDate}}. We went another way this time. We'll send the next one your way." + SIGN,
    wired: false,
    unwiredReason: "Bidding arrives in Block 3.",
  },
  ...(
    [
      ["crew_reminder_30", "Crew reminder, 30 days out", "30 days before the gig.", "30 days"],
      ["crew_reminder_15", "Crew reminder, 15 days out", "15 days before the gig.", "15 days"],
      ["crew_reminder_7", "Crew reminder, 7 days out", "7 days before the gig.", "a week"],
      ["crew_reminder_3", "Crew reminder, 3 days out", "3 days before the gig.", "3 days"],
      ["crew_reminder_eve", "Crew reminder, the day before", "The day before the gig.", "tomorrow"],
    ] as const
  ).map(
    ([key, label, when, lead]): TriggerDef => ({
      key,
      journey: "crew",
      sendClass: "reminder",
      label,
      when,
      stopsWhen: "The gig is cancelled, the crew member is replaced, or the gig has happened.",
      tokens: ["crewFirstName", "gigRole", "gigDate", "gigStartTime", "gigAddress", "gigLink"],
      sms: `Hi {{crewFirstName}}, your {{gigRole}} gig is ${lead === "tomorrow" ? "tomorrow" : `in ${lead}`}: {{gigDate}}, {{gigStartTime}}, at {{gigAddress}}. Tap to confirm you're set or flag a question: {{gigLink}}`,
      emailSubject: `Your {{gigRole}} gig ${lead === "tomorrow" ? "is tomorrow" : `is ${lead === "a week" ? "a week" : lead} away`}`,
      emailBody: `Hi {{crewFirstName}},\n\nYour {{gigRole}} gig is ${lead === "tomorrow" ? "tomorrow" : `in ${lead}`}: {{gigDate}}, {{gigStartTime}}, at {{gigAddress}}.\n\nTap to confirm you're set or flag a question: {{gigLink}}` + SIGN,
      wired: true,
      note: "Sends by text only. Until the crew gig page ships (Block 3) there is no {{gigLink}}, so these are logged as Blocked and nothing goes.",
    }),
  ),
];

// The company name signs every email, so every message may use it.
export const TRIGGERS: TriggerDef[] = [...lead, ...client, ...crew].map((t) => ({ ...t, tokens: [...new Set([...t.tokens, "companyName"])] }));

const byKey = new Map(TRIGGERS.map((t) => [t.key, t]));

export function getTrigger(key: string): TriggerDef | undefined {
  return byKey.get(key);
}

export function mustGetTrigger(key: string): TriggerDef {
  const t = byKey.get(key);
  if (!t) throw new Error(`unknown trigger ${key}`);
  return t;
}
