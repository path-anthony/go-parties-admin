// The navigation rule, checked: every page is its own address, groups have
// two or more pages, nothing is claimed twice, and every redirect lands on a
// real page. Run with npm test (not part of the browser bundle).
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEGACY_REDIRECTS, LEGACY_TABS, NAV, allPagePaths, breadcrumbFor, redirectTarget, screenToPath } from "./nav.tsx";

const pages = allPagePaths();
const realTarget = (to: string) => pages.includes(to.split("?")[0]);

test("a group has two or more pages; a section with one page is a link", () => {
  for (const item of NAV) {
    if (item.pages) {
      assert.ok(item.pages.length >= 2, `${item.label} is a group with fewer than two pages`);
      assert.equal(item.element, undefined, `${item.label} is a group and should have no page of its own`);
    } else {
      assert.ok(item.element, `${item.label} is a link and needs a page`);
    }
  }
});

test("every page address is unique, starts with its section, and is lowercase words with hyphens", () => {
  assert.equal(new Set(pages).size, pages.length, "duplicate address");
  for (const item of NAV) {
    for (const p of item.pages ?? []) assert.ok(p.path.startsWith(`${item.path}/`), `${p.path} is outside ${item.path}`);
  }
  for (const p of pages) assert.match(p, /^\/[a-z]+(-[a-z]+)*(\/[a-z]+(-[a-z]+)*)?$/, p);
});

test("every old address redirects to a real page", () => {
  for (const [from, to] of LEGACY_REDIRECTS) {
    assert.ok(realTarget(to), `${from} goes to ${to}, which is not a page`);
    assert.ok(!pages.includes(from), `${from} is both a page and a redirect`);
  }
  for (const [group, tabs] of Object.entries(LEGACY_TABS)) {
    assert.ok(NAV.some((n) => n.path === group && n.pages), `${group} has legacy tabs but is not a group`);
    for (const [tab, to] of Object.entries(tabs)) assert.ok(realTarget(to), `${group}?tab=${tab} goes to ${to}`);
  }
});

test("every place the app sends you (navigate) lands on a real page", () => {
  for (const item of NAV) {
    const to = screenToPath(item.key);
    assert.ok(realTarget(to), `${item.key} -> ${to}`);
  }
  assert.equal(screenToPath("leads", { leadView: "requests" }), "/leads?view=requests");
  assert.equal(screenToPath("leads"), "/leads");
  assert.equal(screenToPath("crew", { gigStatus: "Needs Crew", gigId: "abc" }), "/crew/gigs?status=Needs+Crew&gig=abc");
  assert.equal(screenToPath("messages"), "/messages/upcoming");
  assert.equal(screenToPath("bookings"), "/bookings");
  assert.equal(screenToPath("inventory"), "/inventory/items");
  assert.equal(screenToPath("today"), "/today");
});

test("the breadcrumb matches the sidebar path", () => {
  assert.deepEqual(breadcrumbFor("/settings/booking-rules").map((c) => c.label), ["Settings", "Booking rules"]);
  assert.deepEqual(breadcrumbFor("/crew/skills").map((c) => c.label), ["Crew and Gigs", "Skills"]);
  assert.deepEqual(breadcrumbFor("/inventory/availability").map((c) => c.label), ["Inventory", "Availability"]);
  assert.deepEqual(breadcrumbFor("/bookings").map((c) => c.label), ["Bookings"]);
  assert.deepEqual(breadcrumbFor("/messages/sent-log").map((c) => c.label), ["Messages", "Sent log"]);
  assert.deepEqual(breadcrumbFor("/leads").map((c) => c.label), ["Leads"]);
  assert.deepEqual(breadcrumbFor("/today").map((c) => c.label), ["Today"]);
});

test("the pages that were on the old Settings screen and its tabs all have a home", () => {
  // An old address counts if it is a page now or redirects to one.
  const redirected = new Map(LEGACY_REDIRECTS);
  const want = ["/settings/business-rules", "/settings/policies", "/settings/contract-terms", "/settings/contract-settings", "/settings/lead-pipeline", "/settings/notifications", "/settings/integrations", "/settings/home-photos", "/settings/team", "/messages/upcoming", "/messages/templates", "/messages/sent-log", "/crew/skills", "/scheduling/bookings", "/scheduling/inventory-status", "/crew/gigs", "/crew/bids", "/crew/members"];
  for (const w of want) assert.ok(pages.includes(w) || (redirected.has(w) && pages.includes(redirected.get(w) ?? "")), w);
});

// Block A12: Settings is seven pages, and every old Settings address lands on
// the page that now holds its fields.
test("Settings has seven pages and each old address redirects to its new home", () => {
  const settings = NAV.find((n) => n.key === "settings");
  assert.deepEqual(
    settings?.pages?.map((p) => p.label),
    ["Business", "Booking rules", "Contract and policy", "Messages and notifications", "Home photos", "Integrations", "Team"],
  );
  const redirected = new Map(LEGACY_REDIRECTS);
  assert.equal(redirected.get("/settings/business-rules"), "/settings/booking-rules");
  assert.equal(redirected.get("/settings/policies"), "/settings/contract-and-policy");
  assert.equal(redirected.get("/settings/contract-terms"), "/settings/contract-and-policy");
  assert.equal(redirected.get("/settings/contract-settings"), "/settings/contract-and-policy");
  assert.equal(redirected.get("/settings/lead-pipeline"), "/settings/notifications");
  assert.equal(LEGACY_TABS["/settings"].general, "/settings/booking-rules");
});

test("the Notifications page has its own address and stays out of the sidebar", () => {
  assert.ok(pages.includes("/notifications"));
  assert.equal(NAV.find((n) => n.key === "notifications")?.hiddenFromSidebar, true);
  assert.deepEqual(breadcrumbFor("/notifications").map((c) => c.label), ["Notifications"]);
  assert.equal(NAV.filter((n) => n.hiddenFromSidebar).length, 1);
});

// Block F3a: the menu, renamed and reordered, with every old address kept.
test("the menu is Today, Leads, Bookings, Inventory, Crew and Gigs, Messages, Settings", () => {
  assert.deepEqual(NAV.filter((n) => !n.hiddenFromSidebar).map((n) => n.label), ["Today", "Leads", "Bookings", "Inventory", "Crew and Gigs", "Messages", "Settings"]);
  assert.deepEqual(NAV.find((n) => n.key === "inventory")?.pages?.map((p) => p.label), ["Items", "Packages and themes", "Availability"]);
  assert.equal(NAV.some((n) => /scheduling|design/i.test(n.label)), false, "Scheduling and Design requests are gone from the menu");
});

test("old addresses land on the new ones and keep what was after the question mark", () => {
  const to = new Map(LEGACY_REDIRECTS);
  assert.equal(to.get("/overview"), "/today");
  assert.equal(to.get("/"), "/today");
  assert.equal(to.get("/scheduling/bookings"), "/bookings");
  assert.equal(to.get("/scheduling/inventory-status"), "/inventory/availability");
  assert.equal(to.get("/packages"), "/inventory/packages");
  assert.equal(to.get("/design-requests"), "/leads?view=requests");
  // A link to one booking, already sent in an email or a digest, still opens it.
  assert.equal(redirectTarget("/bookings", "?booking=abc123"), "/bookings?booking=abc123");
  assert.equal(redirectTarget("/leads?view=requests", "?status=Open"), "/leads?view=requests");
  assert.equal(redirectTarget("/today", ""), "/today");
  // /inventory was a page and is a group now: its own address opens Items.
  assert.equal(NAV.find((n) => n.path === "/inventory")?.pages?.[0].path, "/inventory/items");
});
