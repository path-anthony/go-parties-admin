import { createContext, useContext } from "react";
import type { ScreenKey } from "../components/AdminShell";

// What a screen can be opened with. Overview's cards use this to land on
// a filtered view rather than the plain screen: the Leads board on one
// stage (or on the leads needing a follow-up), Crew & Gigs on one status
// or straight into one gig.
export type ScreenParams = {
  leadStatus?: string;
  leadFollowUp?: boolean;
  // With leadStatus: only the leads in that column untouched for this many days.
  leadStaleDays?: number;
  gigStatus?: string;
  gigId?: string;
};

export type Navigate = (screen: ScreenKey, params?: ScreenParams) => void;

export const NavigationContext = createContext<Navigate>(() => {});

export function useNavigate(): Navigate {
  return useContext(NavigationContext);
}

// Leads in an early stage that nobody has touched for this long need a
// follow-up. Computed on the fly from updatedAt; nothing is stored.
export const FOLLOW_UP_DAYS = 3;

export function needsFollowUp(lead: { status: string; updatedAt: string }, earlyStages: string[], now = Date.now()): boolean {
  if (!earlyStages.includes(lead.status)) return false;
  return now - new Date(lead.updatedAt).getTime() >= FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000;
}

// The board's columns are configurable, so the well-known stages are
// found by name, case-insensitively, and may be absent.
// A proposal that has sat this long without a touch needs chasing.
export const PROPOSAL_FOLLOW_UP_DAYS = 5;

export function daysSinceUpdate(lead: { updatedAt: string }, now = Date.now()): number {
  return (now - new Date(lead.updatedAt).getTime()) / (24 * 60 * 60 * 1000);
}

export function findStage(statuses: string[], name: string): string | undefined {
  return statuses.find((s) => s.toLowerCase() === name.toLowerCase());
}
