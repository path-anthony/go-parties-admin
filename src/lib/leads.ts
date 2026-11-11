import type { Lead, LeadSource } from "./types";

export const SOURCE_LABEL: Record<LeadSource, string> = {
  "ask-go": "Ask GO",
  manual: "Staff",
  phone: "Phone or in person",
  website: "Website form",
  storefront: "Storefront",
  concierge: "Talk to us",
};

// A concierge lead has no name (Calendly takes it), so it reads by what
// the customer was looking at.
export function leadTitle(lead: Lead): string | null {
  return lead.customerName ?? lead.occasion ?? (lead.source === "concierge" ? lead.theme : null);
}
