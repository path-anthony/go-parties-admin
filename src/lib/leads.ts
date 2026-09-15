import type { Lead, LeadSource } from "./types";

export const SOURCE_LABEL: Record<LeadSource, string> = {
  "ask-go": "Ask GO",
  manual: "Manual",
  website: "Website",
  storefront: "Storefront",
};

export function leadTitle(lead: Lead): string | null {
  return lead.customerName ?? lead.occasion;
}
