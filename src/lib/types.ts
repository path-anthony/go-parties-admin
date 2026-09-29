import type { BalancePreference, BookingStage, DisplayStatus } from "./bookingStatus";
import type { ItemSource } from "./itemFields";
import type { GigStatus, OfferStatus, Skill } from "./skills";

// One option inside a group. priceDelta is a serialized Decimal and can be
// zero (a free choice) or negative (a downgrade).
export type Addon = {
  id: string;
  addonGroupId: string;
  name: string;
  priceDelta: string;
  position: number;
  createdAt: string;
};

// One question about an item ("Flavor"). A booking picks at most one of its
// addons; required means the item can't be booked without an answer.
export type AddonGroup = {
  id: string;
  itemId: string;
  name: string;
  required: boolean;
  position: number;
  createdAt: string;
  addons: Addon[];
};

// What a booking chose, with the names and price copied at booking time.
export type BookingAddon = {
  id: string;
  // The live rows this choice was made from; null once either is deleted.
  // Only present on a booking's own addons, not on a lead's slim view.
  itemId?: string | null;
  addonId?: string | null;
  itemName: string;
  groupName: string;
  addonName: string;
  priceDelta: string;
  quantity: number;
};

export type Item = {
  id: string;
  accountId: string;
  name: string;
  category: string;
  price: string | null; // serialized Decimal
  priceUnit: string | null;
  // Admin only. Where the item comes from, and whether its price still
  // needs a human look. Neither reaches the storefront.
  source: ItemSource;
  needsPriceReview: boolean;
  notes: string | null;
  photoUrl: string | null;
  // The crew skills the item needs to run, any number, independent of
  // whether it has units. Booking it creates one gig per skill.
  skills: Skill[];
  addonGroups: AddonGroup[];
  createdAt: string;
  updatedAt: string;
};

export type NewItem = {
  name: string;
  category: string;
  price: string;
  priceUnit: string;
  source: ItemSource;
  needsPriceReview: boolean;
  notes: string;
  photoUrl: string;
  skills: Skill[];
  // Unit rows created with the item. Ignored (forced to 0) when skills
  // are set, since a service item is covered by crew.
  startingUnits: number;
};

// A skill as Settings manages it, with how many items and crew list it.
export type SkillRow = {
  id: string;
  accountId: string;
  name: string;
  position: number;
  createdAt: string;
  usedByItems: number;
  usedByCrew: number;
};

export type CrewMember = {
  id: string;
  accountId: string;
  name: string;
  phone: string | null;
  email: string | null;
  skills: Skill[];
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CrewMemberInput = {
  name: string;
  phone: string;
  email: string;
  skills: Skill[];
  active: boolean;
  notes: string;
};

export type GigOffer = {
  id: string;
  gigId: string;
  crewMemberId: string;
  status: OfferStatus;
  createdAt: string;
  updatedAt: string;
  crewMember: { id: string; name: string; phone: string | null; email: string | null; active: boolean };
};

// One person needed for one service item on one booking.
export type Gig = {
  id: string;
  accountId: string;
  bookingId: string;
  itemId: string | null;
  itemName: string;
  skill: Skill;
  eventDate: string; // serialized DATE
  status: GigStatus;
  filledById: string | null;
  createdAt: string;
  updatedAt: string;
  booking: { id: string; customerName: string; eventDate: string; eventTime: string | null; status: BookingStatus; leadId: string | null; rush: boolean; retainerPaid: boolean; balancePaymentPreference: BalancePreference; agreement: AgreementInfo | null };
  filledBy: { id: string; name: string } | null;
  offers: GigOffer[];
};

// The gig plus every active crew member with its skill.
export type GigDetail = Gig & {
  candidates: { id: string; name: string; phone: string | null; email: string | null }[];
};

// The slim gig view carried on an admin booking.
export type BookingGig = {
  id: string;
  itemId: string | null;
  itemName: string;
  skill: Skill;
  status: GigStatus;
  filledBy: { id: string; name: string } | null;
};

// One row of a bulk-add file as the server read it. problems empty means
// it will be created.
export type BulkRow = {
  line: number;
  name: string;
  category: string;
  categoryNew: boolean;
  price: number | null;
  billedPer: string | null;
  skills: Skill[];
  startingUnits: number;
  notes: string | null;
  problems: string[];
};

export type BulkPreview = {
  headers: string[];
  missingHeaders: string[];
  rows: BulkRow[];
  creatable: number;
  categoriesNew: string[];
  categoriesReused: string[];
};

export type BulkSummary = {
  created: number;
  skipped: { line: number; name: string; reasons: string[] }[];
  categoriesNew: string[];
  categoriesReused: string[];
  itemIds: string[];
};

// What deleting an item would touch. packages is every package, Draft or
// Published, that lists it, with how many distinct items each holds (so a
// count of 1 means the package would be left empty). heldByBookings is the
// number of Confirmed or Completed bookings holding one of the item's
// units; the delete is refused while that is above zero.
export type ItemUsage = {
  packages: { id: string; name: string; status: PackageStatus; itemCount: number }[];
  heldByBookings: number;
};

export type ItemDeleteResult = {
  ok: true;
  removedFrom: { id: string; name: string }[];
  unpublished: { id: string; name: string }[];
};

// What deleting a whole selection would touch. blocked lists the items a
// live booking holds (the delete refuses while it is not empty); each
// package says how many of its items are selected and whether that is all
// of them, which is what unpublishes a Published one.
export type BulkItemUsage = {
  items: { id: string; name: string }[];
  blocked: { id: string; name: string; heldByBookings: number }[];
  packages: { id: string; name: string; status: PackageStatus; itemCount: number; selectedCount: number; emptied: boolean }[];
};

export type BulkItemDeleteResult = {
  ok: true;
  deleted: number;
  removedFrom: { id: string; name: string }[];
  unpublished: { id: string; name: string }[];
};

export type AskGoMessage = { role: "user" | "assistant"; content: string };

// An item as customers see it: the same allowlist the public catalog uses.
// No notes, no account, no timestamps.
export type RecommendItem = {
  id: string;
  name: string;
  category: string;
  price: number | null;
  priceUnit: string | null;
  photoUrl: string | null;
  hasUnits: boolean;
  addonGroups: { id: string; name: string; required: boolean; addons: { id: string; name: string; priceDelta: number }[] }[];
};

export type RecommendResponse =
  | { ready: false; message: string; suggestConcierge: false }
  | { ready: true; message: string; items: RecommendItem[]; total: number; suggestConcierge: boolean };

// The name of a LeadStatusRow. Columns are configurable in Settings, so
// this is a plain string, not a fixed union.
export type LeadStatus = string;
export type LeadSource = "ask-go" | "manual" | "website" | "storefront" | "concierge";

export type LeadStatusRow = {
  id: string;
  accountId: string;
  name: string;
  position: number;
  createdAt: string;
};

export type LeadItems = {
  items: { id: string; name: string; category: string; price: number | null; priceUnit: string | null }[];
  total: number;
  // Ask GO thought this party warranted a planning call. Absent on older leads.
  suggestConcierge?: boolean;
};

export type Lead = {
  id: string;
  accountId: string;
  status: LeadStatus;
  source: LeadSource;
  sortOrder: number;
  tags: string[];
  customerName: string | null;
  contact: string | null;
  occasion: string | null;
  dateOfInterest: string | null; // serialized DATE, "YYYY-MM-DDT00:00:00.000Z"
  notes: string | null;
  theme: string | null;
  itemsReturned: LeadItems | null;
  // A slim view of the bookings made from this lead, with their add-ons.
  bookings?: LeadBooking[];
  createdAt: string;
  updatedAt: string;
};

export type LeadBooking = {
  id: string;
  eventDate: string;
  eventTime: string | null;
  status: BookingStatus;
  rush: boolean;
  retainerPaid: boolean;
  balancePaymentPreference: BalancePreference;
  agreement: AgreementInfo | null;
  total: string | null;
  addons: BookingAddon[];
};

export type NewLead = {
  customerName: string;
  contact: string;
  occasion: string;
  dateOfInterest: string;
  notes: string;
  status: LeadStatus;
};

export type LeadPatch = Partial<Pick<Lead, "customerName" | "contact" | "occasion" | "notes" | "status" | "tags">> & {
  dateOfInterest?: string | null; // "YYYY-MM-DD" or null to clear
};

export type LeadActivity = {
  id: string;
  leadId: string;
  text: string;
  createdAt: string;
};

export const UNIT_STATUSES = ["Available", "Booked", "Maintenance"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

export type Unit = {
  id: string;
  itemId: string;
  label: string;
  status: UnitStatus;
  createdAt: string;
  updatedAt: string;
};

export type NewUnit = { itemId: string; label: string; status: UnitStatus };
export type UnitPatch = Partial<Pick<Unit, "label" | "status">>;

// "Cart #1" numbers from 1; a pattern without "#n" numbers from 1 too.
export type BulkUnitsRequest = { itemIds: string[]; labelPattern: string; quantity: number; status: UnitStatus };
export type BulkUnitsResult = { created: number; items: { itemId: string; labels: string[] }[] };

export const PACKAGE_STATUSES = ["Draft", "Published"] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

export type PackageItemRow = {
  packageId: string;
  itemId: string;
  quantity: number;
  item: { id: string; name: string; category: string; price: string | null; priceUnit: string | null };
};

export type Package = {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  price: string; // serialized Decimal, the manual bundle price
  status: PackageStatus;
  // Short customer-facing search terms, suggested by Claude and edited.
  keywords: string[];
  // The storefront sub-occasions it is offered under; one or more to publish.
  occasions: string[];
  photoUrl: string | null;
  items: PackageItemRow[];
  createdAt: string;
  updatedAt: string;
};

export type PackageInput = {
  name: string;
  description: string;
  keywords: string[];
  occasions: string[];
  price: string;
  photoUrl: string;
  items: { itemId: string; quantity: number }[];
};

// The stage set by hand. What a booking reads as (Confirmed only when it is
// Signed with the retainer paid) is displayStatus in ./bookingStatus.
export { BOOKING_STAGES } from "./bookingStatus";
export type BookingStatus = BookingStage;

// What a customer agreed to on a booking, slim. The contract fields are
// reserved for the signed-contract integration and are null until then.
export type AgreementInfo = {
  id: string;
  checkboxChecked: boolean;
  agreedAt: string;
  contractProvider: string | null;
  contractExternalId: string | null;
  contractStatus: string | null;
  contractUrl: string | null;
  policyVersion: { id: string; version: number };
};

export type Booking = {
  id: string;
  accountId: string;
  leadId: string | null;
  eventDate: string; // serialized DATE, "YYYY-MM-DDT00:00:00.000Z"
  eventTime: string | null;
  address: string | null;
  customerName: string;
  // Both required for new bookings; either can be null on rows from before
  // the contact split, which sorted the old single value into one side.
  phone: string | null;
  email: string | null;
  // The stage set by hand.
  status: BookingStatus;
  // What it reads as, computed: Confirmed only when Signed and retainerPaid.
  displayStatus: DisplayStatus;
  // Booked or moved inside the minimum notice window. Visibility only.
  rush: boolean;
  retainerPaid: boolean;
  occasion: string | null;
  balancePaymentPreference: BalancePreference;
  // The balance (total less the deposit) has been paid; ticked by hand.
  balancePaid: boolean;
  // Null on bookings made before agreements existed.
  agreement: AgreementInfo | null;
  customerId: string | null; // set when booked from a customer account
  total: string | null; // what the customer was quoted, add-ons included
  addons: BookingAddon[];
  gigs: BookingGig[];
  unitIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type BookingPatch = {
  leadId?: string | null;
  eventDate?: string;
  customerName?: string;
  phone?: string;
  email?: string;
  status?: BookingStatus;
  unitIds?: string[];
  eventTime?: string | null;
  address?: string | null;
  retainerPaid?: boolean;
  balancePaid?: boolean;
  balancePaymentPreference?: BalancePreference;
};

// Account-wide settings: rush notice, review routing, deposit.
export type AccountSettings = {
  minBookingNoticeHours: number;
  // Null until a real number is set.
  rushContactPhone: string | null;
  fullReviewThreshold: number;
  reviewOccasions: string[];
  depositPercentage: number;
  cancellationWindowDays: number;
  requireAgreementCheckbox: boolean;
  staffNotifyPhone: string | null;
  staffNotifyEmail: string | null;
  balanceReminderWindowDays: number;
  authorizedSignerName: string | null;
  authorizedSignerTitle: string | null;
};

export type PolicyVersionInfo = { id: string; version: number; text: string; createdAt: string; agreements: number };

// An item as the public catalog returns it for one date: only items with a
// free unit or a free person that day, with how many.
export type AvailableItem = RecommendItem & { freeUnits: number };

export type CustomerMatch = { id: string; name: string | null; phone: string; email: string };

// What the admin's New booking sends. It is the storefront's direct
// booking plus a quantity per item, an optional price, and the staff-only
// fields: that the customer agreed, and which design request this turns
// into a booking.
export type StaffBookingRequest = {
  customerId?: string;
  customerName: string;
  phone: string;
  email: string;
  itemIds: string[];
  quantities: Record<string, number>;
  addons: Record<string, string[]>;
  eventDate: string;
  eventTime?: string;
  address?: string;
  total?: number | null;
  occasion?: string;
  balancePaymentPreference: BalancePreference;
  agreed: boolean;
  designRequestId?: string;
};

export type StaffBookingResult =
  | { reviewRequired?: false; bookingId: string; leadId: string; stage: DisplayStatus; rush: boolean; total: number | null }
  | { reviewRequired: true; designRequestId: string; reasons: ("threshold" | "occasion")[]; total: number | null; message: string };

export type DesignRequest = {
  id: string;
  status: "Open" | "Converted" | "Dismissed";
  reasons: ("threshold" | "occasion")[];
  occasion: string | null;
  eventDate: string;
  eventTime: string | null;
  address: string | null;
  customerName: string;
  phone: string | null;
  email: string | null;
  customerId: string | null;
  packageId: string | null;
  total: number | null;
  balancePaymentPreference: BalancePreference;
  notes: string | null;
  bookingId: string | null;
  createdAt: string;
  cart: {
    items: { itemId: string; name: string; quantity: number; price: number | null }[];
    addons: { itemId: string; addonId: string | null; itemName: string; groupName: string; addonName: string; priceDelta: number; quantity: number }[];
    package: { id: string; name: string; price: number } | null;
    computedTotal: number | null;
  };
};

// One line of the send log: a text or email the system tried to send.
// status is our attempt (sent, failed, skipped-*); confirmation is what n8n
// reported afterwards (delivered or failed), if it has.
export type MessageLogRow = {
  id: string;
  channel: "sms" | "email";
  direction: string;
  source: "admin" | "n8n";
  purpose: string;
  recipient: string;
  subject: string | null;
  body: string;
  status: string;
  error: string | null;
  providerRef: string | null;
  bookingId: string | null;
  designRequestId: string | null;
  crewMemberId: string | null;
  gigId: string | null;
  confirmation: "delivered" | "failed" | null;
  confirmationAt: string | null;
  confirmationDetail: string | null;
  createdAt: string;
};

export type MessageSummary = {
  days: number;
  sms: { total: number; sent: number; failed: number; skipped: number; delivered: number };
  email: { total: number; sent: number; failed: number; skipped: number; delivered: number };
  lastAt: string | null;
};

export type MessageTarget = { bookingId: string } | { designRequestId: string } | { leadId: string } | { crewMemberId: string };
