// The navigation rule, checked: every page is its own address, groups have
// two or more pages, nothing is claimed twice, and every redirect lands on a
// real page. Run with npm test (not part of the browser bundle).
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEGACY_REDIRECTS, LEGACY_TABS, NAV, allPagePaths, breadcrumbFor, screenToPath } from "./nav.tsx";

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
  assert.equal(screenToPath("leads", { leadStatus: "Booked" }), "/leads?status=Booked");
  assert.equal(screenToPath("leads", { leadFollowUp: true }), "/leads?followUp=1");
  assert.equal(screenToPath("leads", { leadStatus: "Proposal sent", leadStaleDays: 5 }), "/leads?status=Proposal+sent&staleDays=5");
  assert.equal(screenToPath("crew", { gigStatus: "Needs Crew", gigId: "abc" }), "/crew/gigs?status=Needs+Crew&gig=abc");
  assert.equal(screenToPath("messages"), "/messages/upcoming");
  assert.equal(screenToPath("scheduling"), "/scheduling/bookings");
});

test("the breadcrumb matches the sidebar path", () => {
  assert.deepEqual(breadcrumbFor("/settings/business-rules").map((c) => c.label), ["Settings", "Business rules"]);
  assert.deepEqual(breadcrumbFor("/crew/skills").map((c) => c.label), ["Crew & Gigs", "Skills"]);
  assert.deepEqual(breadcrumbFor("/messages/sent-log").map((c) => c.label), ["Messages", "Sent log"]);
  assert.deepEqual(breadcrumbFor("/leads").map((c) => c.label), ["Leads"]);
  assert.deepEqual(breadcrumbFor("/design-requests").map((c) => c.label), ["Design requests"]);
});

test("the pages that were on the old Settings screen and its tabs all have a home", () => {
  const want = ["/settings/business-rules", "/settings/policies", "/settings/lead-pipeline", "/settings/notifications", "/settings/integrations", "/messages/upcoming", "/messages/templates", "/messages/sent-log", "/crew/skills", "/scheduling/bookings", "/scheduling/inventory-status", "/crew/gigs", "/crew/members"];
  for (const w of want) assert.ok(pages.includes(w), w);
});
