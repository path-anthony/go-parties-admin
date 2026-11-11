// Block A12: Settings went from nine pages to seven. Every control that was
// there before must still be there, exactly once, on the page the plan says,
// and every line of guidance must be plain. Run with npm test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { NAV } from "./nav.tsx";
import { EDITOR_COPY, PAGES } from "./settingsCopy.ts";

const before = JSON.parse(readFileSync(new URL("./settingsFields.before.json", import.meta.url), "utf8")) as { settings: string[]; panels: string[] };

const settingsPages = NAV.find((n) => n.key === "settings")?.pages ?? [];

function keysOn(path: string): string[] {
  const page = settingsPages.find((p) => p.path === path);
  assert.ok(page, `no page at ${path}`);
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, page.element));
  return [...html.matchAll(/data-setting="([^"]+)"/g)].map((m) => m[1]);
}

// Where each control lives now (the plan's field table).
const EXPECTED: Record<string, string[]> = {
  "/settings/business": ["contractCompanyName", "contractAddressLine", "contractPhone", "rushContactPhone", "contractEmail", "contractWebsite", "contractFooterLine", "contractLogo"],
  "/settings/booking-rules": [
    "requireCustomerAccount", "requireAgreementCheckbox", "minBookingNoticeHours", "reviewAmountWedding", "reviewAmountCorporate", "reviewAmountKids", "reviewAmountAdult", "reviewAmountDefault", "requestResponseDays", "contractRequiredOver", "contractRequiredForCrewed",
    "depositPercentage", "balanceDueDays", "tier1Collect", "saveCardForBalance", "retainerReminderDay1", "retainerReminderDay2", "retainerReminderDay3", "holdReminderEmails", "cancellationWindowDays", "holdReleaseDays", "contractHoldReleaseDays", "aiDailyCap", "directBookingDailyCap", "requireBotCheck",
  ],
  "/settings/contract-and-policy": ["panel:policy", "useGoContract", "panel:contractTerms", "signAndPayWindowDays", "returnedCheckFee", "rescheduleFeePercent", "outsidePlannerChargePercent", "authorizedSignerName", "authorizedSignerTitle", "panel:serviceRows"],
  "/settings/notifications": ["staffNotifyPhone", "staffNotifyEmail", "balanceReminderWindowDays", "digestEnabled", "digestEmail", "panel:leadColumns"],
  "/settings/home-photos": ["panel:homePhotos"],
  "/settings/integrations": ["panel:statusText", "panel:statusEmail", "panel:statusAutomation", "panel:statusStripe", "panel:statusMaps", "panel:googleCalendar", "panel:statusStorefront", "payLinksOpenStorefront"],
  "/settings/team": ["panel:team"],
};

test("every account setting in the app has a control on the new pages, matching what the old pages had", () => {
  const types = readFileSync(new URL("./lib/types.ts", import.meta.url), "utf8");
  const block = types.slice(types.indexOf("export type AccountSettings = {"));
  const typed = [...block.slice(0, block.indexOf("\n};")).matchAll(/^ {2}([a-zA-Z0-9]+):/gm)].map((m) => (m[1] === "contractLogoSet" ? "contractLogo" : m[1]));
  assert.deepEqual([...typed].sort(), [...before.settings].sort(), "the list of settings the old pages had no longer matches the settings the app knows");
});

test("after the cleanup the same controls are shown, none lost and none twice", () => {
  const all = Object.keys(EXPECTED).flatMap(keysOn);
  assert.equal(new Set(all).size, all.length, `shown twice: ${all.filter((k, i) => all.indexOf(k) !== i).join(", ")}`);
  assert.deepEqual([...all].sort(), [...before.settings, ...before.panels].sort());
});

test("each control is on the page the plan says", () => {
  for (const [path, want] of Object.entries(EXPECTED)) assert.deepEqual([...keysOn(path)].sort(), [...want].sort(), path);
});

test("every page has an intro, every section a line, every field a label and help", () => {
  assert.equal(PAGES.length, 7);
  for (const page of PAGES) {
    assert.ok(page.intro.trim().length > 0, `${page.id} has no intro`);
    assert.ok(page.intro.length <= 140, `${page.id} intro is not one short line`);
    assert.ok(settingsPages.some((p) => p.path === page.path && p.label.length > 0), `${page.id} is not in the sidebar`);
    for (const s of page.sections) {
      assert.ok(s.title.trim() && s.blurb.trim(), `${page.id}/${s.id} needs a title and a line`);
      assert.ok(s.fields || s.panel, `${page.id}/${s.id} shows nothing`);
      for (const f of s.fields ?? []) assert.ok(f.label.trim() && f.help.trim(), `${f.key} needs a label and help`);
    }
  }
});

test("the guidance is plain: no em dashes, no internal names", () => {
  const lines: string[] = [];
  for (const page of PAGES) {
    lines.push(page.title, page.intro);
    for (const s of page.sections) {
      lines.push(s.title, s.blurb);
      for (const f of s.fields ?? []) lines.push(f.label, f.help);
    }
  }
  for (const line of lines) {
    assert.ok(!line.includes("—"), `em dash in: ${line}`);
    assert.ok(!/[a-z][A-Z]/.test(line.replace(/GO!DJ|iPhone|PDFs?/g, "")), `an internal name in: ${line}`);
    assert.ok(!/_/.test(line), `an internal name in: ${line}`);
  }
  const editor = JSON.stringify(EDITOR_COPY);
  assert.ok(!editor.includes("—"));
});

test("Require an account to book is the first thing on Booking rules", () => {
  const rules = PAGES.find((p) => p.id === "booking-rules");
  assert.equal(rules?.sections[0].fields?.[0].key, "requireCustomerAccount");
  assert.equal(rules?.sections[0].fields?.[0].label, "Require an account to book");
});

test("the unpaid-hold settings sit side by side, labelled Small rentals and Contract bookings", () => {
  const rules = PAGES.find((p) => p.id === "booking-rules");
  const fields = rules?.sections.flatMap((s) => s.fields ?? []) ?? [];
  const small = fields.find((f) => f.key === "holdReleaseDays");
  const contract = fields.find((f) => f.key === "contractHoldReleaseDays");
  assert.equal(small?.label, "Small rentals");
  assert.equal(contract?.label, "Contract bookings");
  assert.equal(small?.row, contract?.row);
  assert.equal(fields.find((f) => f.key === "rushContactPhone"), undefined, "the company phone is on Business, not Booking rules");
  assert.equal(PAGES.find((p) => p.id === "business")?.sections[0].fields?.find((f) => f.key === "rushContactPhone")?.label, "Company phone (used in texts and emails)");
});
