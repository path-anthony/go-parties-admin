export type Item = {
  id: string;
  accountId: string;
  name: string;
  category: string;
  price: string | null; // serialized Decimal
  priceUnit: string | null;
  notes: string | null;
  photoUrl: string | null;
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
};

export type AskGoMessage = { role: "user" | "assistant"; content: string };

export type RecommendResponse =
  | { ready: false; message: string }
  | { ready: true; message: string; items: Item[]; total: number };

// The name of a LeadStatusRow. Columns are configurable in Settings, so
// this is a plain string, not a fixed union.
export type LeadStatus = string;
export type LeadSource = "ask-go" | "manual" | "website";

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
  createdAt: string;
  updatedAt: string;
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
