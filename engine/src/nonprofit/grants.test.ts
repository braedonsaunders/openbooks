import assert from "node:assert/strict";
import test from "node:test";
import { calculateAllowableSpend, calculateIndirectCost, grantReportStatus } from "./grants.ts";

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
