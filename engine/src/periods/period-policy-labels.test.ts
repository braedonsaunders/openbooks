import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPeriodLabel, periodDisplayLabel, periodDisplayName } from "./period-policy.ts";

test("regular periods share one label format with zero-padded numbers", () => {
  assert.equal(canonicalPeriodLabel({ fiscalYear: 2025, periodNumber: 1, adjustment: false }), "P01 FY2025");
  assert.equal(canonicalPeriodLabel({ fiscalYear: 2025, periodNumber: 12, adjustment: false }), "P12 FY2025");
});

test("the adjustment period is labelled by its fiscal year", () => {
  assert.equal(canonicalPeriodLabel({ fiscalYear: 2025, periodNumber: 13, adjustment: true }), "FY2025 adjustment");
});

test("a period whose stored name is the canonical label shows no second name", () => {
  assert.deepEqual(
    periodDisplayName({ name: "P11 FY2025", fiscalYear: 2025, periodNumber: 11, adjustment: false }),
    { label: "P11 FY2025", storedName: null },
  );
});

test("a seeded date-style name is replaced by the canonical label and kept alongside", () => {
  assert.deepEqual(
    periodDisplayName({ name: "2025-09", fiscalYear: 2025, periodNumber: 9, adjustment: false }),
    { label: "P09 FY2025", storedName: "2025-09" },
  );
});

test("a custom name is kept visible, and surrounding whitespace is not treated as a difference", () => {
  assert.deepEqual(
    periodDisplayName({ name: "  Q1 close  ", fiscalYear: 2026, periodNumber: 3, adjustment: false }),
    { label: "P03 FY2026", storedName: "Q1 close" },
  );
  assert.equal(
    periodDisplayName({ name: " P03 FY2026 ", fiscalYear: 2026, periodNumber: 3, adjustment: false }).storedName,
    null,
  );
});

test("the list text names the stored value only when it differs from the label", () => {
  assert.equal(
    periodDisplayLabel({ name: "P11 FY2025", fiscalYear: 2025, periodNumber: 11, adjustment: false }),
    "P11 FY2025",
  );
  assert.equal(
    periodDisplayLabel({ name: "2025-09", fiscalYear: 2025, periodNumber: 9, adjustment: false }),
    "P09 FY2025 (2025-09)",
  );
  assert.equal(
    periodDisplayLabel({ name: "FY2025 adjustment", fiscalYear: 2025, periodNumber: 13, adjustment: true }),
    "FY2025 adjustment",
  );
});
