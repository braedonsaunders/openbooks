import assert from "node:assert/strict";
import test from "node:test";
import {
  hasUnsavedObservation,
  secondObservationNeedsReason,
  SECOND_COUNT_REASON_MIN_LENGTH,
} from "./observation-reason";

test("an agreeing second count is recorded without a reason prompt", () => {
  assert.equal(secondObservationNeedsReason("7", "7.0000"), false);
  assert.equal(secondObservationNeedsReason("7.0000", "7"), false);
});

test("a differing second count needs its explanation before it is recorded", () => {
  assert.equal(secondObservationNeedsReason("8", "7.0000"), true);
  assert.equal(secondObservationNeedsReason("0", "0.5"), true);
});

test("a line without a first observation always asks for the reason", () => {
  assert.equal(secondObservationNeedsReason("7", null), true);
});

test("a value that cannot be compared exactly is treated as differing, never as agreeing", () => {
  assert.equal(secondObservationNeedsReason("7.00001", "7.0000"), true);
  assert.equal(secondObservationNeedsReason("seven", "7.0000"), true);
});

test("the reason the engine accepts for a differing second count is five characters", () => {
  assert.equal(SECOND_COUNT_REASON_MIN_LENGTH, 5);
});

test("an empty entry is not an unsaved observation", () => {
  assert.equal(hasUnsavedObservation("", "7.0000"), false);
  assert.equal(hasUnsavedObservation("   ", null), false);
});

test("a typed first observation is unsaved until its value matches the recorded quantity", () => {
  assert.equal(hasUnsavedObservation("7", null), true);
  assert.equal(hasUnsavedObservation("7", "7.0000"), false);
  assert.equal(hasUnsavedObservation("8", "7.0000"), true);
});

test("a value that cannot be compared exactly is unsaved", () => {
  assert.equal(hasUnsavedObservation("7.00001", "7.0000"), true);
});
