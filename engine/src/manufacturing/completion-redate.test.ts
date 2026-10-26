import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCorrectedCompletionDate,
  completionCorrectionKey,
  latestDate,
  normalizeCompletionCorrectionReason,
} from "./completion-redate.ts";
import { ManufacturingError } from "./errors.ts";

function refusalOf(action: () => unknown): ManufacturingError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof ManufacturingError, "expected a ManufacturingError refusal");
    return error;
  }
  assert.fail("expected a refusal");
}

test("a correction reason is trimmed and must be 5 to 500 characters", () => {
  assert.equal(
    normalizeCompletionCorrectionReason("  Receipt was dated the entry day.  "),
    "Receipt was dated the entry day.",
  );
  assert.equal(
    refusalOf(() => normalizeCompletionCorrectionReason("  abc ")).code,
    "completion_correction_reason_required",
  );
  assert.equal(
    refusalOf(() => normalizeCompletionCorrectionReason("x".repeat(501))).code,
    "completion_correction_reason_required",
  );
});

test("a corrected date must be a calendar date", () => {
  const refusal = refusalOf(() =>
    assertCorrectedCompletionDate({
      correctedOn: "2026-02-31",
      today: "2026-10-11",
      floor: null,
      earliestReceiptDate: "2026-10-11",
    }),
  );
  assert.equal(refusal.code, "invalid_completion_correction_date");
});

test("a corrected date may not be after today", () => {
  const refusal = refusalOf(() =>
    assertCorrectedCompletionDate({
      correctedOn: "2026-10-12",
      today: "2026-10-11",
      floor: null,
      earliestReceiptDate: "2026-10-11",
    }),
  );
  assert.equal(refusal.code, "completion_date_in_future");
});

test("a corrected date may not precede the operations and postings the completion records", () => {
  const refusal = refusalOf(() =>
    assertCorrectedCompletionDate({
      correctedOn: "2026-02-03",
      today: "2026-10-11",
      floor: "2026-02-05",
      earliestReceiptDate: "2026-10-11",
    }),
  );
  assert.equal(refusal.code, "completion_date_before_floor");
  assert.equal(refusal.remedy, "Use 2026-02-05 or a later date.");
});

test("a correction only moves the completion earlier", () => {
  const refusal = refusalOf(() =>
    assertCorrectedCompletionDate({
      correctedOn: "2026-10-12",
      today: "2026-10-12",
      floor: null,
      earliestReceiptDate: "2026-10-11",
    }),
  );
  assert.equal(refusal.code, "completion_date_not_earlier");
});

test("a corrected date on the floor and before the receipt is accepted", () => {
  assert.doesNotThrow(() =>
    assertCorrectedCompletionDate({
      correctedOn: "2026-02-05",
      today: "2026-10-11",
      floor: "2026-02-05",
      earliestReceiptDate: "2026-10-11",
    }),
  );
  assert.doesNotThrow(() =>
    assertCorrectedCompletionDate({
      correctedOn: "2026-02-03",
      today: "2026-10-11",
      floor: null,
      earliestReceiptDate: "2026-10-11",
    }),
  );
});

test("the correction key is stable for the same work order, day and reason", () => {
  const first = completionCorrectionKey("org-1", "wo-1", "2026-02-03", "Entered on the wrong day.");
  assert.equal(
    first,
    completionCorrectionKey("org-1", "wo-1", "2026-02-03", "Entered on the wrong day."),
  );
  assert.notEqual(
    first,
    completionCorrectionKey("org-1", "wo-1", "2026-02-04", "Entered on the wrong day."),
  );
  assert.notEqual(
    first,
    completionCorrectionKey("org-1", "wo-2", "2026-02-03", "Entered on the wrong day."),
  );
  assert.notEqual(
    first,
    completionCorrectionKey("org-1", "wo-1", "2026-02-03", "A different reason."),
  );
});

test("the latest of the present dates is the floor, ignoring absent values", () => {
  assert.equal(latestDate([null, "2026-02-03", undefined, "2026-01-30"]), "2026-02-03");
  assert.equal(latestDate([null, null]), null);
});
