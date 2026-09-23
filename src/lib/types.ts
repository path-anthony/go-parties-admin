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
  booking: { id: string; customerName: string; eventDate: string; eventTime: string | null; status: BookingStatus; leadId: string | null };
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

export const BOOKING_STATUSES = ["Confirmed", "Completed", "Cancelled"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

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
  status: BookingStatus;
  depositPaid: boolean;
  customerId: string | null; // set when booked from a customer account
  total: string | null; // what the customer was quoted, add-ons included
  addons: BookingAddon[];
  gigs: BookingGig[];
  unitIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type NewBooking = {
  leadId: string | null;
  eventDate: string; // "YYYY-MM-DD"
  eventTime: string;
  address: string;
  customerName: string;
  phone: string;
  email: string;
  status: BookingStatus;
  unitIds: string[];
};

export type BookingPatch = Partial<Omit<NewBooking, "eventTime" | "address">> & {
  eventTime?: string | null;
  address?: string | null;
  depositPaid?: boolean;
};
