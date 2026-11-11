/* oxlint-disable react/only-export-components -- this file is the navigation config: the tree, its routes and address helpers live together on purpose, so adding a page is one line. */
import type { ReactElement } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { Box, Briefcase, CalendarDays, ChartBar, Contact, MessageSquare, Settings, type LucideIcon } from "lucide-react";
import { CrewGigsScreen } from "./components/screens/CrewGigsScreen";
import { InventoryScreen } from "./components/screens/InventoryScreen";
import { LeadsInboxScreen } from "./components/screens/LeadsInboxScreen";
import { BidsPage } from "./components/screens/BidsPage";
import { MessageTemplatesPage, MessagesUpcomingPage, SentLogPage } from "./components/screens/MessagesScreen";
import { NotificationsScreen } from "./components/screens/NotificationsScreen";
import { PackagesScreen } from "./components/screens/PackagesScreen";
import { SchedulingScreen } from "./components/screens/SchedulingScreen";
import { BookingRulesPage, BusinessPage, ContractAndPolicyPage, HomePhotosPage, IntegrationsPage, MessagesAndNotificationsPage } from "./components/screens/SettingsPages";
import { SkillsPage } from "./components/screens/SkillsPage";
import { TeamPage } from "./components/screens/TeamPage";
import { TodayScreen } from "./components/screens/TodayScreen";
import type { ScreenKey, ScreenParams } from "./lib/navigation";

// THE navigation, in one place. The sidebar, the routes, the breadcrumb and
// the redirects are all built from NAV, so adding a page is one line.
//
// The rule (also in CLAUDE.md):
//   - A section with one page is a direct link: give it `path` and `element`.
//   - A section with two or more pages is a group: give it `pages`. Each
//     page is its own address and its own full page. Never add in-page tabs.
//   - Every old address keeps working: add it to LEGACY_REDIRECTS.
//

// ownerOnly: the page is listed and routed only for Owners (the server
// refuses everyone else regardless).
export type NavPage = { label: string; path: string; element: ReactElement; ownerOnly?: boolean };
export type NavItem = {
  key: ScreenKey;
  label: string;
  icon: LucideIcon;
  // A direct link has path + element. A group has path (its own prefix) + pages.
  path: string;
  element?: ReactElement;
  pages?: NavPage[];
  // Where navigate(key) lands when it isn't the first page.
  landing?: string;
  // A real page with its own address that is reached from somewhere else
  // (the bell) and takes no place in the sidebar.
  hiddenFromSidebar?: boolean;
};

function BookingsRoute() {
  const [q] = useSearchParams();
  return <SchedulingScreen view="bookings" openBookingId={q.get("booking") ?? undefined} />;
}

function GigsRoute() {
  const [q] = useSearchParams();
  return <CrewGigsScreen view="gigs" initialStatus={q.get("status") ?? undefined} openGigId={q.get("gig") ?? undefined} />;
}

// Block F3a: the menu, in the order the day is worked. Today, Leads,
// Bookings, Inventory (Items, Packages and themes, Availability), Crew and
// Gigs, Messages, Settings. Storefront requests are a view inside Leads, and
// "Scheduling" is gone: its two pages moved to Bookings and to Inventory.
export const NAV: NavItem[] = [
  { key: "notifications", label: "Notifications", icon: MessageSquare, path: "/notifications", element: <NotificationsScreen />, hiddenFromSidebar: true },
  { key: "today", label: "Today", icon: ChartBar, path: "/today", element: <TodayScreen /> },
  // The views (New, Storefront requests, ...) and the open lead live in the
  // address: /leads?view=requests, /leads?lead=<id>, /leads?request=<id>.
  { key: "leads", label: "Leads", icon: Contact, path: "/leads", element: <LeadsInboxScreen /> },
  { key: "bookings", label: "Bookings", icon: CalendarDays, path: "/bookings", element: <BookingsRoute /> },
  {
    key: "inventory",
    label: "Inventory",
    icon: Box,
    path: "/inventory",
    pages: [
      { label: "Items", path: "/inventory/items", element: <InventoryScreen /> },
      { label: "Packages and themes", path: "/inventory/packages", element: <PackagesScreen /> },
      { label: "Availability", path: "/inventory/availability", element: <SchedulingScreen view="units" /> },
    ],
  },
  {
    key: "crew",
    label: "Crew and Gigs",
    icon: Briefcase,
    path: "/crew",
    pages: [
      { label: "Gigs", path: "/crew/gigs", element: <GigsRoute /> },
      { label: "Bids", path: "/crew/bids", element: <BidsPage /> },
      { label: "Crew", path: "/crew/members", element: <CrewGigsScreen view="crew" /> },
      { label: "Skills", path: "/crew/skills", element: <SkillsPage /> },
    ],
  },
  {
    key: "messages",
    label: "Messages",
    icon: MessageSquare,
    path: "/messages",
    landing: "/messages/upcoming",
    pages: [
      { label: "Upcoming", path: "/messages/upcoming", element: <MessagesUpcomingPage /> },
      { label: "Templates", path: "/messages/templates", element: <MessageTemplatesPage /> },
      { label: "Sent log", path: "/messages/sent-log", element: <SentLogPage /> },
    ],
  },
  {
    key: "settings",
    label: "Settings",
    icon: Settings,
    path: "/settings",
    pages: [
      { label: "Business", path: "/settings/business", element: <BusinessPage /> },
      { label: "Booking rules", path: "/settings/booking-rules", element: <BookingRulesPage /> },
      { label: "Contract and policy", path: "/settings/contract-and-policy", element: <ContractAndPolicyPage /> },
      { label: "Messages and notifications", path: "/settings/notifications", element: <MessagesAndNotificationsPage /> },
      { label: "Home photos", path: "/settings/home-photos", element: <HomePhotosPage /> },
      { label: "Integrations", path: "/settings/integrations", element: <IntegrationsPage /> },
      { label: "Team", path: "/settings/team", element: <TeamPage />, ownerOnly: true },
    ],
  },
];

// Addresses that used to be, or could have been, bookmarked or linked, and
// where they live now. The admin had no addresses of its own before this
// (it was one page at "/"), so these cover the screens as they were named
// and the old Settings tabs.
export const LEGACY_REDIRECTS: [from: string, to: string][] = [
  ["/", "/today"],
  // Block F3a: the menu was renamed and reordered. Everything that was ever
  // bookmarked, or sent in an email or a digest, still lands in the right
  // place, and whatever was after the "?" comes along (LegacyRedirect).
  ["/overview", "/today"],
  ["/scheduling", "/bookings"],
  ["/scheduling/bookings", "/bookings"],
  ["/scheduling/inventory-status", "/inventory/availability"],
  ["/scheduling/units", "/inventory/availability"],
  ["/packages", "/inventory/packages"],
  ["/design-requests", "/leads?view=requests"],
  ["/design-requests/open", "/leads?view=requests"],
  ["/settings/general", "/settings/booking-rules"],
  // Block A12: Settings went from nine pages to seven.
  ["/settings/business-rules", "/settings/booking-rules"],
  ["/settings/policies", "/settings/contract-and-policy"],
  ["/settings/contract-terms", "/settings/contract-and-policy"],
  ["/settings/contract-settings", "/settings/contract-and-policy"],
  ["/settings/lead-pipeline", "/settings/notifications"],
  ["/settings/messages", "/messages/templates"],
  ["/settings/message-log", "/messages/sent-log"],
  ["/settings/skills", "/crew/skills"],
  ["/settings/lead-columns", "/settings/notifications"],
  ["/crew/crew", "/crew/members"],
  ["/crew/people", "/crew/members"],
  ["/gigs", "/crew/gigs"],
  ["/log", "/messages/sent-log"],
];

// Where an old address goes, keeping what came after the "?" (a link to one
// booking, /scheduling/bookings?booking=abc, must still open that booking).
// When the new address has its own "?", both sets are kept and the new one wins.
export function redirectTarget(to: string, search: string): string {
  const [path, own] = to.split("?");
  const q = new URLSearchParams(search);
  for (const [k, v] of new URLSearchParams(own ?? "")) q.set(k, v);
  // The old Design requests list took ?status=Open; the inbox has no use for it.
  if (path === "/leads" && q.get("view") === "requests") q.delete("status");
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

export function LegacyRedirect({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={redirectTarget(to, search)} replace />;
}

// The tab the old in-page tabs would have been on, as a query string, sent
// to the right page. Applies to a group's root address: /settings?tab=log.
export const LEGACY_TABS: Record<string, Record<string, string>> = {
  "/settings": { general: "/settings/booking-rules", messages: "/messages/templates", log: "/messages/sent-log", "message-log": "/messages/sent-log", skills: "/crew/skills" },
  "/crew": { gigs: "/crew/gigs", crew: "/crew/members", skills: "/crew/skills" },
};

export const allPagePaths = (): string[] => NAV.flatMap((n) => (n.pages ? n.pages.map((p) => p.path) : [n.path]));

// The pages this person may see: Staff do not get the owner-only ones.
export const visiblePages = (item: NavItem, isOwner: boolean): NavPage[] => (item.pages ?? []).filter((p) => isOwner || !p.ownerOnly);

// A group's own address goes to its first page, or to the tab a legacy
// link named.
export function GroupRoot({ item, tabs }: { item: NavItem; tabs?: Record<string, string> }) {
  const [q] = useSearchParams();
  const tab = q.get("tab");
  const to = (tab && tabs?.[tab]) || item.pages![0].path;
  return <Navigate to={to} replace />;
}

// Where navigate(screen, params) goes.
export function screenToPath(screen: ScreenKey, params: ScreenParams = {}): string {
  const item = NAV.find((n) => n.key === screen);
  if (!item) return "/today";
  const base = item.landing ?? item.pages?.[0].path ?? item.path;
  const q = new URLSearchParams();
  if (screen === "leads" && params.leadView) q.set("view", params.leadView);
  if (screen === "crew") {
    if (params.gigStatus) q.set("status", params.gigStatus);
    if (params.gigId) q.set("gig", params.gigId);
  }
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

// "Settings / Booking rules" for the top of the page.
export function breadcrumbFor(pathname: string): { label: string; to?: string }[] {
  for (const item of NAV) {
    if (item.pages) {
      const page = item.pages.find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`));
      if (page) return [{ label: item.label, to: item.landing ?? item.pages[0].path }, { label: page.label }];
    } else if (pathname === item.path || pathname.startsWith(`${item.path}/`)) {
      return [{ label: item.label }];
    }
  }
  return [{ label: "Today" }];
}
