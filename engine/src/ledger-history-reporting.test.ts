import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * `reversed` is a lifecycle state on an original POSTED journal. Its lines
 * remain ledger history and must be aggregated with the linked posted
 * reversal. Operational commands may require literal `posted`, but financial
 * reporting modules must never silently drop the original. Reconciliation is
 * one of those operational workflows: it matches the currently posted
 * bank-facing entry, while the reporting modules below retain both lifecycle
 * rows.
 */
const FINANCIAL_REPORT_MODULES = [
  "engine/src/dashboard-reporting.ts",
  "engine/src/continuous-close.ts",
  "engine/src/tax-return.ts",
  "engine/src/income-tax-provision.ts",
  "engine/src/fx-revaluation.ts",
  "engine/src/project-revenue.ts",
  "engine/src/construction-billing.ts",
  "engine/src/validation/project-parity-certificate.ts",
  "web/lib/reports/statements.ts",
  "web/lib/reports/trends.ts",
  "web/lib/reports/aging.ts",
  "web/lib/reports/cash-flow.ts",
  "web/lib/reports/cash-flow-indirect.ts",
  "web/lib/reports/registers.ts",
  "web/lib/reports/ledger-reports.ts",
  "web/lib/reports/transaction-detail.ts",
  "web/lib/reports/projects.ts",
  "engine/src/project-financials.ts",
  "web/lib/project-costing.ts",
  "web/lib/budget-report.ts",
  "web/lib/statement-matrix.ts",
  "web/lib/report-drill-data.ts",
  "web/lib/cash/core.ts",
  "web/lib/analytics/health-data.ts",
] as const;

const ACTIVE_ONLY_OPERATION_MODULES = ["engine/src/banking.ts"] as const;

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

test("bank reconciliation is active-only without changing reporting history", () => {
  for (const file of ACTIVE_ONLY_OPERATION_MODULES) {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    assert.match(source, /\bje\.status\s*=\s*['"]posted['"]/);
    assert.doesNotMatch(
      source,
      /\bje\.status\s+in\s*\(\s*['"]posted['"]\s*,\s*['"]reversed['"]\s*\)/,
      `${file} admits reversed originals to active reconciliation matching`,
    );
    assert.match(
      source,
      /\bbool_or\(je\.status\s*<>\s*['"]posted['"]\)/,
      `${file} must reject a previously stored match that became reversed`,
    );
  }
});
