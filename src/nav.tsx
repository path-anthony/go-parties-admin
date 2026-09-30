/* oxlint-disable react/only-export-components -- this file is the navigation config: the tree, its routes and address helpers live together on purpose, so adding a page is one line. */
import type { ReactElement } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Box, Briefcase, CalendarDays, ChartBar, ClipboardList, Contact, Layers2, MessageSquare, Settings, type LucideIcon } from "lucide-react";
import { CrewGigsScreen } from "./components/screens/CrewGigsScreen";
import { DesignRequestsScreen } from "./components/screens/DesignRequestsScreen";
import { InventoryScreen } from "./components/screens/InventoryScreen";
import { LeadsScreen } from "./components/screens/LeadsScreen";
import { MessageTemplatesPage, MessagesUpcomingPage, SentLogPage } from "./components/screens/MessagesScreen";
import { OverviewScreen } from "./components/screens/OverviewScreen";
import { PackagesScreen } from "./components/screens/PackagesScreen";
import { SchedulingScreen } from "./components/screens/SchedulingScreen";
import { BusinessRulesPage, IntegrationsPage, LeadPipelinePage, NotificationsPage, PoliciesPage } from "./components/screens/SettingsPages";
import { SkillsPage } from "./components/screens/SkillsPage";
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
// Room left for later, not built yet:
//   Leads (groups), Crew & Gigs > Bids, Messages > Upcoming,
//   Settings > Account and access.

export type NavPage = { label: string; path: string; element: ReactElement };
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
};

const num = (v: string | null) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);

// Overview's cards send filters along in the address (?status=Booked), so
// the page they open is bookmarkable.
function LeadsRoute() {
  const [q] = useSearchParams();
  return <LeadsScreen openLeadId={q.get("lead") ?? undefined} initialStatus={q.get("status") ?? undefined} initialFollowUp={q.get("followUp") === "1"} initialStaleDays={num(q.get("staleDays"))} />;
}

function BookingsRoute() {
  const [q] = useSearchParams();
  return <SchedulingScreen view="bookings" openBookingId={q.get("booking") ?? undefined} />;
}

function GigsRoute() {
  const [q] = useSearchParams();
  return <CrewGigsScreen view="gigs" initialStatus={q.get("status") ?? undefined} openGigId={q.get("gig") ?? undefined} />;
}

export const NAV: NavItem[] = [
  { key: "overview", label: "Overview", icon: ChartBar, path: "/overview", element: <OverviewScreen /> },
  { key: "leads", label: "Leads", icon: Contact, path: "/leads", element: <LeadsRoute /> },
  {
    key: "scheduling",
    label: "Scheduling",
    icon: CalendarDays,
    path: "/scheduling",
    pages: [
      { label: "Bookings", path: "/scheduling/bookings", element: <BookingsRoute /> },
      { label: "Inventory status", path: "/scheduling/inventory-status", element: <SchedulingScreen view="units" /> },
    ],
  },
  // Inventory has one page (search and category filter sit at the top of it),
  // so it is a link, not a group.
  { key: "inventory", label: "Inventory", icon: Box, path: "/inventory", element: <InventoryScreen /> },
  // Themes are not a separate screen in the app, so this is a link too.
  { key: "packages", label: "Packages & Themes", icon: Layers2, path: "/packages", element: <PackagesScreen /> },
  { key: "requests", label: "Design requests", icon: ClipboardList, path: "/design-requests", element: <DesignRequestsScreen /> },
  {
    key: "crew",
    label: "Crew & Gigs",
    icon: Briefcase,
    path: "/crew",
    pages: [
      { label: "Gigs", path: "/crew/gigs", element: <GigsRoute /> },
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
      { label: "Business rules", path: "/settings/business-rules", element: <BusinessRulesPage /> },
      { label: "Policies and contracts", path: "/settings/policies", element: <PoliciesPage /> },
      { label: "Lead pipeline", path: "/settings/lead-pipeline", element: <LeadPipelinePage /> },
      { label: "Notifications", path: "/settings/notifications", element: <NotificationsPage /> },
      { label: "Integrations", path: "/settings/integrations", element: <IntegrationsPage /> },
    ],
  },
];

// Addresses that used to be, or could have been, bookmarked or linked, and
// where they live now. The admin had no addresses of its own before this
// (it was one page at "/"), so these cover the screens as they were named
// and the Settings tabs from Block 1.
export const LEGACY_REDIRECTS: [from: string, to: string][] = [
  ["/", "/overview"],
  ["/settings/general", "/settings/business-rules"],
  ["/settings/messages", "/messages/templates"],
  ["/settings/message-log", "/messages/sent-log"],
  ["/settings/skills", "/crew/skills"],
  ["/settings/lead-columns", "/settings/lead-pipeline"],
  ["/scheduling/units", "/scheduling/inventory-status"],
  ["/crew/crew", "/crew/members"],
  ["/crew/people", "/crew/members"],
  ["/design-requests/open", "/design-requests?status=Open"],
  ["/gigs", "/crew/gigs"],
  ["/bookings", "/scheduling/bookings"],
  ["/log", "/messages/sent-log"],
];

// The tab the old in-page tabs would have been on, as a query string, sent
// to the right page. Applies to a group's root address: /settings?tab=log.
export const LEGACY_TABS: Record<string, Record<string, string>> = {
  "/settings": { general: "/settings/business-rules", messages: "/messages/templates", log: "/messages/sent-log", "message-log": "/messages/sent-log", skills: "/crew/skills" },
  "/scheduling": { bookings: "/scheduling/bookings", units: "/scheduling/inventory-status" },
  "/crew": { gigs: "/crew/gigs", crew: "/crew/members", skills: "/crew/skills" },
};

export const allPagePaths = (): string[] => NAV.flatMap((n) => (n.pages ? n.pages.map((p) => p.path) : [n.path]));

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
  if (!item) return "/overview";
  const base = item.landing ?? item.pages?.[0].path ?? item.path;
  const q = new URLSearchParams();
  if (screen === "leads") {
    if (params.leadStatus) q.set("status", params.leadStatus);
    if (params.leadFollowUp) q.set("followUp", "1");
    if (params.leadStaleDays !== undefined) q.set("staleDays", String(params.leadStaleDays));
  }
  if (screen === "crew") {
    if (params.gigStatus) q.set("status", params.gigStatus);
    if (params.gigId) q.set("gig", params.gigId);
  }
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

// "Settings / Business rules" for the top of the page.
export function breadcrumbFor(pathname: string): { label: string; to?: string }[] {
  for (const item of NAV) {
    if (item.pages) {
      const page = item.pages.find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`));
      if (page) return [{ label: item.label, to: item.landing ?? item.pages[0].path }, { label: page.label }];
    } else if (pathname === item.path || pathname.startsWith(`${item.path}/`)) {
      return [{ label: item.label }];
    }
  }
  return [{ label: "Overview" }];
}
