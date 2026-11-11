import { createContext, useContext } from "react";

// The places other screens can send you (a finished New booking, a card).
// Each maps to a real address in src/nav.tsx. A screen can be opened on a
// view: the Leads inbox on one view, Crew and Gigs on one status or one gig.
export type ScreenKey = "today" | "leads" | "bookings" | "inventory" | "crew" | "messages" | "settings" | "notifications";

export type ScreenParams = {
  // Which view of the Leads inbox to open on (requests, follow-up, ...).
  leadView?: string;
  gigStatus?: string;
  gigId?: string;
};

export type Navigate = (screen: ScreenKey, params?: ScreenParams) => void;

export const NavigationContext = createContext<Navigate>(() => {});

export function useNavigate(): Navigate {
  return useContext(NavigationContext);
}
