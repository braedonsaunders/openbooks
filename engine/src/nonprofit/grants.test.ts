import assert from "node:assert/strict";
import test from "node:test";
import { calculateAllowableSpend, calculateIndirectCost, grantReportStatus, modifiedTotalDirectCosts } from "./grants.ts";
import { NonprofitError } from "./errors.ts";

test("grant cost bases use exact percentages and report status is derived from its due date", () => {
  const cases = [
    { base: "direct_costs" as const, direct: "100.00", modified: "80.00", rate: "12.5", indirect: "12.5000", allowable: "112.5000" },
    { base: "modified_total_direct" as const, direct: "100.00", modified: "80.00", rate: "12.5", indirect: "10.0000", allowable: "110.0000" },
    { base: "direct_costs" as const, direct: "0.01", modified: "0.01", rate: "50", indirect: "0.0050", allowable: "0.0150" },
  ];
  for (const row of cases) {
    assert.equal(calculateIndirectCost({
      directCosts: row.direct,
      modifiedTotalDirect: row.modified,
      ratePercent: row.rate,
      base: row.base,
    }), row.indirect);
    assert.equal(calculateAllowableSpend({
      directCosts: row.direct,
      modifiedTotalDirect: row.modified,
      ratePercent: row.rate,
      base: row.base,
    }), row.allowable);
  }

  const deadlines = [
    { row: { dueOn: "2026-09-27", submittedAt: null }, asOf: "2026-09-27", expected: "upcoming" },
    { row: { dueOn: "2026-09-26", submittedAt: null }, asOf: "2026-09-27", expected: "overdue" },
    { row: { dueOn: "2026-09-26", submittedAt: "2026-09-26T14:00:00Z" }, asOf: "2026-09-27", expected: "submitted" },
  ] as const;
  for (const deadline of deadlines) {
    assert.equal(grantReportStatus(deadline.row, deadline.asOf), deadline.expected);
  }
});

test("modified total direct costs leave out excluded costs and each subaward above its threshold", () => {
  // 100k direct including 40k equipment at 30% allows 100k + 18k, not 100k + 30k.
  const base = modifiedTotalDirectCosts({ directCosts: "100000", excludedCosts: "40000", subawardsBySubrecipient: [], subawardThreshold: null });
  assert.equal(base, "60000.0000");
  assert.equal(calculateAllowableSpend({ directCosts: "100000", modifiedTotalDirect: base, ratePercent: "30", base: "modified_total_direct" }), "118000.0000");
  // Each subrecipient keeps only the first 25k of its subaward in the base.
  assert.equal(modifiedTotalDirectCosts({
    directCosts: "200000", excludedCosts: "0", subawardsBySubrecipient: ["70000", "10000"], subawardThreshold: "25000",
  }), "155000.0000");
  assert.throws(
    () => modifiedTotalDirectCosts({ directCosts: "100", excludedCosts: "0", subawardsBySubrecipient: ["50"], subawardThreshold: null }),
    (error: unknown) => error instanceof NonprofitError && error.code === "grant_mtdc_subaward_threshold_missing",
  );
});
