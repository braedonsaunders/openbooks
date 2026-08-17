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
