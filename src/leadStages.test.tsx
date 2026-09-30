import assert from "node:assert/strict";
import { test } from "node:test";
import { isLostStage, isWonStage, stageWarnings } from "./lib/leadStages";

test("Booked counts as won and Lost as lost, ignoring case", () => {
  assert.ok(isWonStage("Booked") && isWonStage(" booked "));
  assert.ok(isLostStage("LOST"));
  assert.ok(!isWonStage("Proposal sent") && !isLostStage("Contacted"));
});

test("a renamed or missing Booked or Lost column is warned about", () => {
  assert.deepEqual(stageWarnings(["New", "Contacted", "Booked", "Proposal sent", "Lost"]), []);
  assert.equal(stageWarnings(["New", "Won", "Lost"]).length, 1);
  assert.match(stageWarnings(["New", "Won", "Lost"])[0], /"Booked"/);
  assert.equal(stageWarnings(["New", "Booked"]).length, 1);
  assert.equal(stageWarnings(["New"]).length, 2);
});
