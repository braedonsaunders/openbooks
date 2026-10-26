import assert from "node:assert/strict";
import test from "node:test";
import { reportTemporalBucketLabel } from "./report-temporal-label";

test("temporal report labels preserve fiscal identity and localize their own civil bounds", () => {
  const period = {
    bin: "fiscal_period",
    from: "2026-07-01",
    to: "2026-07-31",
    fiscalYear: 2027,
    number: 1,
  } as const;
  assert.equal(reportTemporalBucketLabel(period, "en"), "P01 FY2027 · Jul 2026");
  assert.equal(reportTemporalBucketLabel(period, "de"), "P01 FY2027 · Juli 2026");
  assert.equal(
    reportTemporalBucketLabel({ ...period, bin: "fiscal_quarter", to: "2026-09-30" }, "en"),
    "Q1 FY2027 · Jul 2026 – Sep 2026",
  );
  assert.equal(
    reportTemporalBucketLabel({ bin: "day", from: "0099-12-25", to: "0099-12-25" }, "en"),
    "Dec 25, 99",
  );
  assert.equal(
    reportTemporalBucketLabel({ bin: "fiscal_period", from: period.from, to: period.to }, "en"),
    null,
    "missing fiscal identity uses the report executor fallback",
  );
});
