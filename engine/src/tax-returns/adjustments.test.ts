import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateTaxReturnAdjustments,
  normalizeTaxReturnAdjustments,
  TAX_RETURN_ADJUSTMENT_LIMIT,
  TAX_RETURN_ADJUSTMENT_REASON_MAX,
} from "./adjustments.ts";
import { TaxReturnError } from "./return.ts";

const PRE_CONVERSION_REASON = "Jan–Aug 2025 pre-conversion activity per prior system";

test("an adjustment entry is canonicalized to the return's four-place decimal", () => {
  assert.deepEqual(
    normalizeTaxReturnAdjustments([
      { lineCode: " 104 ", amount: " 3018.84 ", reason: `  ${PRE_CONVERSION_REASON}  ` },
    ]),
    [{ lineCode: "104", amount: "3018.8400", reason: PRE_CONVERSION_REASON }],
  );
  assert.equal(
    normalizeTaxReturnAdjustments([{ lineCode: "107", amount: "-50", reason: "Credit note" }])[0]!
      .amount,
    "-50.0000",
  );
});

test("an entry without a reason is refused by name, never recorded blank", () => {
  assert.throws(
    () => normalizeTaxReturnAdjustments([{ lineCode: "104", amount: "100", reason: "   " }]),
    (error: unknown) =>
      error instanceof TaxReturnError && /line 104 needs a reason/.test(error.message),
  );
});

test("an amount that is not a plain decimal is refused by name", () => {
  for (const amount of ["12,34", "abc", "1.23456", "", "1e3"]) {
    assert.throws(
      () => normalizeTaxReturnAdjustments([{ lineCode: "104", amount, reason: "Correction" }]),
      (error: unknown) =>
        error instanceof TaxReturnError && /line 104 is not a decimal amount/.test(error.message),
      `amount "${amount}" must be refused`,
    );
  }
});

test("an entry must name its line and stay within the reason and count limits", () => {
  assert.throws(
    () => normalizeTaxReturnAdjustments([{ lineCode: " ", amount: "1", reason: "Correction" }]),
    TaxReturnError,
  );
  assert.throws(
    () =>
      normalizeTaxReturnAdjustments([
        { lineCode: "104", amount: "1", reason: "x".repeat(TAX_RETURN_ADJUSTMENT_REASON_MAX + 1) },
      ]),
    /longer than 500 characters/,
  );
  const tooMany = Array.from({ length: TAX_RETURN_ADJUSTMENT_LIMIT + 1 }, () => ({
    lineCode: "104",
    amount: "1",
    reason: "Correction",
  }));
  assert.throws(() => normalizeTaxReturnAdjustments(tooMany), /at most 100 adjustment entries/);
});

test("entries on one line sum exactly to the total the return computes", () => {
  // Two prior-system amounts on line 104: the sum is exact, with no float drift.
  const entries = normalizeTaxReturnAdjustments([
    { lineCode: "104", amount: "1000.00", reason: "January to June 2025 per prior system" },
    { lineCode: "104", amount: "2018.84", reason: "July and August 2025 per prior system" },
    { lineCode: "107", amount: "0.10", reason: "ITC correction" },
    { lineCode: "107", amount: "0.20", reason: "ITC correction" },
  ]);
  assert.deepEqual(aggregateTaxReturnAdjustments(entries), { "104": "3018.8400", "107": "0.3000" });
});

test("a negative entry offsets a positive one on the same line", () => {
  assert.deepEqual(
    aggregateTaxReturnAdjustments([
      { lineCode: "104", amount: "500" },
      { lineCode: "104", amount: "-125.5" },
    ]),
    { "104": "374.5000" },
  );
});

test("malformed runtime inputs produce actionable domain refusals", () => {
  const invalid: unknown[] = [
    {},
    { lineCode: "104", amount: 3018.84, reason: "Prior-system activity" },
    null,
  ];
  for (const input of invalid) {
    assert.throws(
      () =>
        normalizeTaxReturnAdjustments([input] as Parameters<
          typeof normalizeTaxReturnAdjustments
        >[0]),
      (error: unknown) =>
        error instanceof TaxReturnError && /complete all three fields/.test(error.message),
    );
  }
  assert.throws(
    () =>
      normalizeTaxReturnAdjustments({ "104": "3018.84" } as unknown as Parameters<
        typeof normalizeTaxReturnAdjustments
      >[0]),
    (error: unknown) => error instanceof TaxReturnError && /must be a list/.test(error.message),
  );
});
