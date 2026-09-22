import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * `reversed` is a lifecycle state on an original POSTED journal. Its lines
 * remain ledger history and must be aggregated with the linked posted
 * reversal. Operational commands may require literal `posted`, but financial
 * reporting modules must never silently drop the original. Reconciliation is
 * one of those operational workflows: matching requires the currently posted
 * entry, while its opening-balance proof retains both lifecycle rows.
 */
const FINANCIAL_REPORT_MODULES = [
  "engine/src/continuous-close/continuous-close.ts",
  "engine/src/tax-returns/return.ts",
  "engine/src/tax-returns/income-tax-provision.ts",
  "engine/src/close/fx-revaluation.ts",
  "engine/src/projects/revenue.ts",
  "engine/src/projects/construction-billing.ts",
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
  "engine/src/projects/financials.ts",
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

test("bank matching stays active-only while the opening proof retains ledger history", () => {
  const source = readFileSync(resolve(process.cwd(), "engine/src/banking/banking.ts"), "utf8");
  for (const [start, end] of [
    ["export async function autoMatch(", "type MatchOptions ="],
    ["async function createMatchInTransaction(", "export async function createMatchWithJournal("],
  ]) {
    const startAt = source.indexOf(start!);
    const endAt = source.indexOf(end!, startAt);
    assert.ok(startAt >= 0 && endAt > startAt, `cannot locate ${start}`);
    const matching = source.slice(startAt, endAt);
    assert.match(matching, /\bje\.status\s*=\s*['"]posted['"]/, `${start} must require a posted match`);
    assert.doesNotMatch(
      matching,
      /\bje\.status\s+in\s*\(\s*['"]posted['"]\s*,\s*['"]reversed['"]\s*\)/,
      `${start} admits reversed originals to active matching`,
    );
  }
  assert.match(
    source,
    /\bbool_or\(je\.status\s*<>\s*['"]posted['"]\)/,
    "sign-off must reject a previously stored match that became reversed",
  );
  const opening = source.slice(source.indexOf("async function firstReconciliationCarry("), source.indexOf("export interface ReconciliationTotals"));
  assert.match(opening, /\bje\.status\s+in\s*\(\s*['"]posted['"]\s*,\s*['"]reversed['"]\s*\)/,
    "the opening balance must include the original and dated reversal");
});
