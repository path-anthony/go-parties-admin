// The GO contract template, version 1: the client's own contract, word for
// word from the blank reference (go-parties-app/reference/GO-contract-blank.pdf).
// The only edits are the business numbers, which are tokens bound to
// Settings so a change there changes the contract without retyping it:
//
//   {{retainerPercent}}              Settings > Business rules, retainer percentage
//   {{lateCancellationDays}}         Settings > Business rules, cancellation window
//   {{balanceDueDays}}               Contract settings
//   {{rescheduleFeePercent}}         Contract settings
//   {{outsidePlannerChargePercent}}  Contract settings
//   {{returnedCheckFee}}             Contract settings (whole dollars, "$50")
//
// server/tests/goContract.test.ts proves that, at the reference's numbers,
// this renders character for character as the reference reads.

export type GoClause = { title: string; body: string };

export type GoTermsContent = {
  header: { title: string; confirmByLine: string; nonRefundableLine: string };
  terms: { heading: string; pageHeader: string; pageSubheader: string; clauses: GoClause[] };
  servicesNote: string;
  paymentNote: string;
  acceptance: { heading: string; text: string; esignLabel: string; confirmLine: string; nonRefundableLine: string };
};

export const GO_TOKENS = ["retainerPercent", "lateCancellationDays", "balanceDueDays", "rescheduleFeePercent", "outsidePlannerChargePercent", "returnedCheckFee"] as const;
export type GoTokenValues = Record<(typeof GO_TOKENS)[number], number>;

// The numbers printed on the reference. The verbatim test renders with these.
export const REFERENCE_NUMBERS: GoTokenValues = {
  retainerPercent: 30,
  lateCancellationDays: 30,
  balanceDueDays: 30,
  rescheduleFeePercent: 20,
  outsidePlannerChargePercent: 20,
  returnedCheckFee: 50,
};

export const GO_TEMPLATE_V1: GoTermsContent = {
  header: {
    title: "THIS IS YOUR OFFICIAL CONTRACT",
    confirmByLine: "DATE AND EVENT ARE NOT CONFIRMED UNTIL RETAINER AND SIGNED CONTRACT ARE RECEIVED BY:",
    nonRefundableLine: "RETAINER IS NON-REFUNDABLE",
  },
  terms: {
    heading: "TERMS AND CONDITIONS",
    pageHeader: "GO EVENT GROUP | SERVICE CONTRACT AND RETAINER AGREEMENT",
    pageSubheader: "RETAINER IS NON-REFUNDABLE - Date and event are not confirmed until retainer and signed contract are received.",
    clauses: [
      {
        title: "Retainer and Confirmation",
        body: "A non-refundable retainer equal to {{retainerPercent}}% of the Total Contracted Amount is due when this contract is signed. The date and event are not confirmed, and no date is held, until Go Event Group's office has received BOTH the signed contract and the retainer. The retainer reserves the date, staff and equipment for the Client and is non-refundable for any reason.",
      },
      {
        title: "Payment",
        body: "The remaining balance, including any additions, applicable taxes, and any check or credit card processing fees, is due in full {{balanceDueDays}} days prior to the contracted event date. Tip and tax are not included in the listed prices; applicable taxes will be added as required by law. Items added after signing are added to the balance. Returned checks incur a ${{returnedCheckFee}} return fee and are subject to late and legal fees. Go Event Group may withhold services if the balance has not been paid by the due date.",
      },
      {
        title: "Cancellation",
        body: "If the Client cancels for any reason, the retainer is considered a cancellation fee and is non-refundable. If the event is cancelled within {{lateCancellationDays}} days of the contracted date, the full contracted balance is due and non-refundable.",
      },
      {
        title: "Rescheduling",
        body: "If the Client requests to reschedule or postpone the event date, a fee of {{rescheduleFeePercent}}% of the contract total will be added to the final costs. A reschedule date must be agreed on in writing by both the Client and Go Event Group and is subject to availability.",
      },
      {
        title: "Event Planners and Coordinators",
        body: "The Client is responsible for a {{outsidePlannerChargePercent}}% service charge if working with a wedding or event planner that is not hired or supplied through Go Event Group.",
      },
      {
        title: "Equipment, Damage and Client Responsibility",
        body: "The Client assumes full responsibility for any damage to the staff's equipment and gear caused by the Client or the Client's guests, whether accidental or intentional, including but not limited to damage by theft, fire, vandalism, water or other liquids, while at the event. The Client agrees to pay the cost of repair or replacement.",
      },
      {
        title: "Staffing and Substitutions",
        body: "Go Event Group will provide requested entertainers and staff whenever possible. In the event of an emergency replacement, the Client is assured an entertainer or staff member of equal caliber. However, the requested staff member is never guaranteed.",
      },
      {
        title: "Venue, Setup and Power",
        body: "The Client is required to furnish one 6 foot table not further than 25 feet from electrical power. The Client is responsible for venue approval of the services, load-in and setup access, and any venue rules, fees or permits, and for providing a safe, covered and powered area for outdoor events. Go Event Group is not responsible for delays or limits caused by the venue.",
      },
      {
        title: "Staff Meals",
        body: "The Go Event Group staff are considered guests and must be provided a meal or meal option at the time the Client's guests are served.",
      },
      {
        title: "Special Effects and Fireworks",
        body: "Special effects (including cold spark fountains, low fog, CO2, confetti, bubbles and fireworks) are subject to venue approval, weather, and all applicable Connecticut and local fire, safety and permit requirements. Fireworks require licensed operators and permits. Go Event Group may modify, delay or decline any effect it believes is unsafe or not permitted, without liability to the Client.",
      },
      {
        title: "Music and Entertainment",
        body: "Go Event Group will honor reasonable music requests and \"do not play\" lists submitted in advance, but the DJ and MC keep final discretion over music selection, volume and event flow. Guests use dance floors, platforms, effects and other equipment at their own risk.",
      },
      {
        title: "Photo and Video; Print and Album Items",
        body: "Go Event Group keeps the copyright in all photos and video it produces and grants the Client a license for personal, non-commercial use. Go Event Group may use event images in its portfolio, website and social media. The Client agrees to forfeit all included print and album items if they are not ordered within 6 months after the contracted event date.",
      },
      {
        title: "Additional Time",
        body: "Time beyond the contracted hours is subject to staff availability and is billed at Go Event Group's then-current rate.",
      },
      {
        title: "Force Majeure; Limit of Liability",
        body: "Go Event Group is not liable for failure or delay in performing due to causes beyond its reasonable control, including severe weather, natural disaster, government order, utility failure, travel restrictions or illness. Go Event Group will make reasonable efforts to provide the services on another mutually agreed date. To the fullest extent permitted by law, Go Event Group's total liability under this contract is limited to the amounts the Client has paid to Go Event Group, and Go Event Group is not liable for indirect or consequential damages. The Client agrees to indemnify Go Event Group against claims arising from the conduct of the Client, the Client's guests or the venue.",
      },
      {
        title: "Electronic Signatures and Records",
        body: "The parties agree that this contract may be signed electronically, by typed or drawn signature, and delivered electronically, and that electronic signatures and copies have the same legal effect as handwritten signatures and originals under the federal ESIGN Act and the Connecticut Uniform Electronic Transactions Act. The Client consents to do business electronically.",
      },
      {
        title: "Governing Law and General Terms",
        body: "This contract is governed by the laws of the State of Connecticut, and any dispute will be brought in the state or federal courts located in Connecticut. This contract is the entire agreement between the parties, may be changed only in a writing signed by both parties, and if any part is found unenforceable the rest remains in effect. The Client confirms that they are at least 18 years old and have authority to sign for any organization named in this contract.",
      },
    ],
  },
  servicesNote:
    "Light-up platforms: 2x2x1 ft $250 ea | 3x4 ft x 18 in $325 ea | 2x2x2 ft $200 ea; custom configurations and layouts available. Color add-on: $30 per light-up section, stationary or revolving color that moves to the music.",
  paymentNote:
    "Gray fields calculate automatically: Services Subtotal = all fees added; Total Contracted Amount = Subtotal minus Total Discount (Discount % x Subtotal + Discount $); the retainer is {{retainerPercent}}% of the Total Contracted Amount, is due at signing and is non-refundable; the Balance (Total minus retainer) is due {{balanceDueDays}} days prior to the event. Enter fees as numbers only. Tip and tax are not included. Special effects and rentals are priced as \"starting at\" and finalized above.",
  acceptance: {
    heading: "ACCEPTANCE AND SIGNATURES",
    text: "By signing below, the Client confirms that they have read, understood and agree to all terms of this contract, including that the retainer ({{retainerPercent}}% of the Total Contracted Amount) is non-refundable and that the date and event are not confirmed until the retainer and this signed contract are received by Go Event Group.",
    esignLabel: "I agree to sign and receive this contract electronically (ESIGN Act / Connecticut UETA).",
    confirmLine: "DATE AND EVENT ARE NOT CONFIRMED UNTIL RETAINER AND SIGNED CONTRACT ARE RECEIVED BY OUR OFFICE.",
    nonRefundableLine: "Retainer is non-refundable.",
  },
};

// The company details as the reference prints them. Settings start here.
export const REFERENCE_COMPANY = {
  name: "Go Event Group",
  addressLine: "767 New Britain Ave, Farmington, Connecticut 06032",
  phone: "413.391.4635 (GO!DJ)",
  email: "info@thegoeventgroup.com",
  website: "www.thegoeventgroup.com",
  footerLine: "Go Event Group | 767 New Britain Ave, Farmington, CT 06032 | 413.391.4635 | info@thegoeventgroup.com | thegoeventgroup.com",
};

// The service rows as the reference lists them, with the catalog categories
// (and a few item-name words) each one gathers. Staff can change any of it.
export type ServiceRowSeed = { column: "left" | "right"; label: string; isGroupHeading?: boolean; categories?: string[]; itemWords?: string[] };

export const SERVICE_ROWS_SEED: ServiceRowSeed[] = [
  { column: "left", label: "Go DJ", itemWords: ["MC and DJ", "DJ Additional Hours", "DJs / Bands"] },
  { column: "left", label: "Go MC", itemWords: ["Emcee"] },
  { column: "left", label: "Event Coordination", categories: ["Planning Services"] },
  { column: "left", label: "Go Photo", itemWords: ["Photography", "Photographer", "Photo Edit", "Sneak Peaks", "Drone"] },
  { column: "left", label: "Go Video", itemWords: ["Videography", "Videographer", "Video Edit", "Hard Drive", "Advanced Editing"] },
  { column: "left", label: "Go Photo Booth", itemWords: ["Photo Booth", "360 Booth", "Magic Mirror", "Digital Photo System"] },
  { column: "left", label: "Uplighting", itemWords: ["Uplighting"] },
  { column: "left", label: "Up-Beat Lighting", itemWords: ["Intelligent Lighting", "Gobo"] },
  { column: "left", label: "Stage / Dance Floor", itemWords: ["Stage", "Dance Floor"] },
  { column: "left", label: "Light-Up Dance Platforms", itemWords: ["Light-Up Dance", "Light-up platform"] },
  { column: "left", label: "Light-Up Color Add-On", itemWords: ["Color Add-On"] },
  { column: "right", label: "Sound System", itemWords: ["Sound System", "Pro Audio"] },
  { column: "right", label: "AV Equipment", itemWords: ["AV Equipment", "Projector", "Streaming", "Technical Support"] },
  { column: "right", label: "Inflatables", categories: ["Inflatables", "Bounce House"] },
  { column: "right", label: "Miscellaneous" },
  { column: "right", label: "SPECIAL EFFECTS (priced \"starting at\")", isGroupHeading: true },
  { column: "right", label: "Cold Spark Fountains", itemWords: ["Cold Spark", "Sparkler"] },
  { column: "right", label: "Dancing on Clouds", itemWords: ["Clouds", "Dry Ice", "Fog"] },
  { column: "right", label: "CO2 Jets and Guns", itemWords: ["CO2"] },
  { column: "right", label: "Confetti Cannon", itemWords: ["Confetti"] },
  { column: "right", label: "Bubble Exit", itemWords: ["Bubble"] },
  { column: "right", label: "Rental Options" },
  { column: "right", label: "Fireworks", itemWords: ["Fireworks"] },
];

// Where an item lands when no row claims it: a service (an item that needs
// crew) under Miscellaneous, a physical rental under Rental Options.
export const FALLBACK_ROW = { service: "Miscellaneous", rental: "Rental Options" } as const;
