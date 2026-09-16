import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { resolveRangeArgs } from "./period-range";

const APRIL = 4;
const TODAY = "2026-08-16";

describe("resolveRangeArgs", () => {
  it("resolves a fiscal preset against the org start month", () => {
    assert.deepEqual(resolveRangeArgs({ period: "this_fiscal_year_to_date" }, APRIL, TODAY), {
      from: "2026-04-01",
      to: "2026-08-16",
      label: "FY 2027 to date",
    });
  });

  it("prefers the preset when explicit dates are also passed", () => {
    const r = resolveRangeArgs(
      { period: "this_fiscal_year_to_date", fromDate: "2026-01-01", toDate: "2026-08-16" },
      APRIL,
      TODAY,
    );
    assert.deepEqual(r, { from: "2026-04-01", to: "2026-08-16", label: "FY 2027 to date" });
  });

  it("accepts an explicit custom range", () => {
    assert.deepEqual(resolveRangeArgs({ fromDate: "2026-05-01", toDate: "2026-05-31" }, APRIL, TODAY), {
      from: "2026-05-01",
      to: "2026-05-31",
      label: "2026-05-01 – 2026-05-31",
    });
  });

  it("rejects an unknown preset and the boundless custom preset", () => {
    assert.deepEqual(resolveRangeArgs({ period: "nonsense" }, APRIL, TODAY), { error: "invalid_period" });
    assert.deepEqual(resolveRangeArgs({ period: "custom" }, APRIL, TODAY), { error: "invalid_period" });
  });

  it("rejects a missing or inverted date pair", () => {
    assert.deepEqual(resolveRangeArgs({ fromDate: "2026-05-01" }, APRIL, TODAY), {
      error: "period_or_date_range_required",
    });
    assert.deepEqual(resolveRangeArgs({}, APRIL, TODAY), { error: "period_or_date_range_required" });
    assert.deepEqual(resolveRangeArgs({ fromDate: "2026-06-01", toDate: "2026-05-01" }, APRIL, TODAY), {
      error: "invalid_period",
    });
  });
});

describe("resolveRangeArgs priorYears", () => {
  it("shifts a preset window back whole fiscal years on its own boundaries", () => {
    assert.deepEqual(resolveRangeArgs({ period: "last_fiscal_quarter", priorYears: 1 }, APRIL, "2026-09-15"), {
      from: "2025-04-01",
      to: "2025-06-30",
      label: "Q1 FY 2027 (prior year)",
    });
    assert.deepEqual(resolveRangeArgs({ period: "this_fiscal_year_to_date", priorYears: 2 }, APRIL, TODAY), {
      from: "2024-04-01",
      to: "2024-08-16",
      label: "FY 2027 to date (2 years earlier)",
    });
  });

  it("shifts an explicit range and clamps leap days", () => {
    assert.deepEqual(resolveRangeArgs({ fromDate: "2024-02-29", toDate: "2024-03-31", priorYears: 1 }, APRIL, TODAY), {
      from: "2023-02-28",
      to: "2023-03-31",
      label: "2024-02-29 – 2024-03-31 (prior year)",
    });
  });

  it("treats priorYears 0 as no shift", () => {
    assert.deepEqual(resolveRangeArgs({ period: "last_fiscal_year", priorYears: 0 }, APRIL, TODAY), {
      from: "2025-04-01",
      to: "2026-03-31",
      label: "FY 2026",
    });
  });
});
