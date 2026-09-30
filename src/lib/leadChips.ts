import { createContext } from "react";

// The one-line automation status for each lead (id -> text), provided by the
// Leads screen and read by each card.
export const LeadChipsContext = createContext<Record<string, string>>({});
