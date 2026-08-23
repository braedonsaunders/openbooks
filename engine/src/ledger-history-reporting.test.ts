import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * `reversed` is a lifecycle state on an original POSTED journal. Its lines
 * remain ledger history and must be aggregated with the linked posted
 * reversal. Operational commands may require literal `posted`, but financial
 * reporting modules must never silently drop the original.
 */
const FINANCIAL_REPORT_MODULES = [
  "engine/src/dashboard-reporting.ts",
  "engine/src/continuous-close.ts",
  "engine/src/tax-return.ts",
  "engine/src/income-tax-provision.ts",
  "engine/src/fx-revaluation.ts",
  "engine/src/project-revenue.ts",
  "engine/src/construction-billing.ts",
  "engine/src/banking.ts",
  "engine/src/validation/project-parity-certificate.ts",
  "web/lib/reports.ts",
  "engine/src/project-financials.ts",
  "web/lib/project-costing.ts",
  "web/lib/budget-report.ts",
  "web/lib/statement-matrix.ts",
  "web/lib/report-drill-data.ts",
  "web/lib/cash/core.ts",
  "web/lib/analytics/health-data.ts",
] as const;

test("financial reporting never excludes reversed posted history", () => {
  for (const file of FINANCIAL_REPORT_MODULES) {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:e|je)\.status\s*=\s*['"]posted['"]/,
      `${file} filters a journal alias to literal posted`,
    );
  }
});
