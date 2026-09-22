import type { Lead, LeadSource } from "./types";

export const SOURCE_LABEL: Record<LeadSource, string> = {
  "ask-go": "Ask GO",
  manual: "Manual",
  website: "Website",
  storefront: "Storefront",
  concierge: "Concierge",
};

// A concierge lead has no name (Calendly takes it), so it reads by what
// the customer was looking at.
export function leadTitle(lead: Lead): string | null {
  return lead.customerName ?? lead.occasion ?? (lead.source === "concierge" ? lead.theme : null);
}
