import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSendRules, easternClock } from "../sendRules.js";

// All instants are given in UTC. September 30, 2026 is a Wednesday and
// Eastern is UTC-4 (daylight time); January 10, 2027 is a Sunday and
// Eastern is UTC-5.
const wedNoon = new Date("2026-09-30T16:00:00Z"); // 12 PM Wednesday
const decision = (cls: "transactional" | "reminder" | "nurture", ch: "sms" | "email", at: Date) => checkSendRules(cls, ch, at);

test("the Eastern clock is read correctly, in summer and winter", () => {
  assert.deepEqual(easternClock(new Date("2026-09-30T13:00:00Z")), { hour: 9, weekday: 3 });
  assert.deepEqual(easternClock(new Date("2027-01-10T14:00:00Z")), { hour: 9, weekday: 0 });
});

test("transactional sends go at any hour, any day", () => {
  for (const at of ["2026-09-30T07:00:00Z", "2026-09-30T04:00:00Z", "2026-10-04T16:00:00Z", "2027-01-10T04:00:00Z"]) {
    assert.equal(decision("transactional", "sms", new Date(at)).allowed, true, at);
    assert.equal(decision("transactional", "email", new Date(at)).allowed, true, at);
  }
});

test("reminder texts: 9 AM up to but not including 8 PM Eastern", () => {
  assert.equal(decision("reminder", "sms", new Date("2026-09-30T12:59:00Z")).allowed, false); // 8:59 AM
  assert.equal(decision("reminder", "sms", new Date("2026-09-30T13:00:00Z")).allowed, true); // 9:00 AM
  assert.equal(decision("reminder", "sms", wedNoon).allowed, true);
  assert.equal(decision("reminder", "sms", new Date("2026-09-30T23:59:00Z")).allowed, true); // 7:59 PM
  const late = decision("reminder", "sms", new Date("2026-10-01T00:00:00Z")); // 8:00 PM
  assert.equal(late.allowed, false);
  assert.equal(!late.allowed && late.status, "deferred_quiet_hours");
  assert.equal(decision("reminder", "sms", new Date("2026-09-30T05:00:00Z")).allowed, false); // 1 AM
});

test("quiet hours follow daylight saving", () => {
  assert.equal(decision("reminder", "sms", new Date("2027-01-11T14:00:00Z")).allowed, true); // 9 AM EST Monday
  assert.equal(decision("reminder", "sms", new Date("2027-01-11T13:59:00Z")).allowed, false); // 8:59 AM EST
});

test("reminder texts may go on a Sunday, inside the hours", () => {
  assert.equal(decision("reminder", "sms", new Date("2026-10-04T16:00:00Z")).allowed, true);
  const night = decision("reminder", "sms", new Date("2026-10-05T02:00:00Z")); // Sunday 10 PM
  assert.equal(!night.allowed && night.status, "deferred_quiet_hours");
});

test("nurture never goes on a Sunday, text or email", () => {
  const sunday = new Date("2026-10-04T16:00:00Z"); // noon
  for (const ch of ["sms", "email"] as const) {
    const d = decision("nurture", ch, sunday);
    assert.equal(d.allowed, false, ch);
    assert.equal(!d.allowed && d.status, "deferred_sunday", ch);
  }
});

test("nurture on other days follows the text hours; email is not held for them", () => {
  assert.equal(decision("nurture", "sms", wedNoon).allowed, true);
  assert.equal(decision("nurture", "sms", new Date("2026-09-30T12:00:00Z")).allowed, false); // 8 AM
  assert.equal(decision("nurture", "email", new Date("2026-09-30T07:00:00Z")).allowed, true); // 3 AM email
});

test("a Sunday night nurture text is deferred for Sunday first", () => {
  const d = decision("nurture", "sms", new Date("2026-10-05T02:00:00Z"));
  assert.equal(!d.allowed && d.status, "deferred_sunday");
});

test("reminder emails are not held for quiet hours", () => {
  assert.equal(decision("reminder", "email", new Date("2026-09-30T07:00:00Z")).allowed, true);
});
