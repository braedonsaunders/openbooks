import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const baseline = readFileSync(
  "schema/migrations/generated/0001_baseline.sql",
  "utf8",
);
const financialSync = readFileSync(
  "engine/src/sync/project-financial-inputs.ts",
  "utf8",
);
const projectFinancials = readFileSync(
  "engine/src/project-financials.ts",
  "utf8",
);

test("time billing is a native lifecycle independent of invoice-line linkage", () => {
  assert.match(baseline, /billing_status text DEFAULT 'unbilled'::text NOT NULL/i);
  assert.match(
    baseline,
    /invoiced_by_line_id IS NULL\) OR \(billing_status = 'billed'::text\)/i,
  );
  assert.match(
    projectFinancials,
    /te\.billing_status = 'unbilled'/i,
  );
  assert.doesNotMatch(
    projectFinancials,
    /te\.invoiced_by_line_id is null/i,
  );
  assert.match(projectFinancials, /const totalTimeBill/i);
  assert.match(projectFinancials, /const totalLineBill/i);
  assert.match(
    projectFinancials,
    /const billableValue = add\(\s*add\(totalTimeBill, totalLineBill\),\s*adjustments\.billable_value,\s*\)/i,
  );
  assert.doesNotMatch(
    projectFinancials,
    /const billableValue = add\(invoicedToDate, unbilledBillable\)/i,
  );
});

test("time costing distinguishes actualized labor from estimates", () => {
  assert.match(
    baseline,
    /costing_basis text DEFAULT 'actual'::text NOT NULL/i,
  );
  assert.match(financialSync, /costing_basis/i);
  assert.match(financialSync, /costingBasis/i);
  assert.match(
    projectFinancials,
    /te\.costing_basis = 'actual'/i,
  );
  assert.match(
    projectFinancials,
    /te\.costing_basis = 'estimated'/i,
  );
});

test("complete-population financial sync reconciles every material time fact", () => {
  for (const column of [
    "employee_party_id",
    "project_id",
    "item_id",
    "department_id",
    "time_type_id",
    "worked_on",
    "hours",
    "cost_rate",
    "bill_rate",
    "is_billable",
    "billing_status",
    "costing_basis",
  ]) {
    assert.match(financialSync, new RegExp(column));
  }
  assert.match(financialSync, /cannot move away from Field Ticket/);
  assert.match(financialSync, /beforeCostRate/);
  assert.match(financialSync, /beforeBillRate/);
});

test("project-financial sync preserves consumed time evidence", () => {
  for (const evidenceColumn of [
    "invoiced_by_line_id",
    "cost_journal_entry_id",
    "overhead_journal_entry_id",
    "payroll_batch_ref",
  ]) {
    assert.match(financialSync, new RegExp(evidenceColumn));
  }
  assert.match(financialSync, /immutableFactChange/);
  assert.match(
    financialSync,
    /corrections must be new offsetting entries/,
  );
  assert.match(
    financialSync,
    /te\.invoiced_by_line_id is null[\s\S]*te\.cost_journal_entry_id is null[\s\S]*te\.payroll_batch_ref is null/,
  );
});

test("project-financial input sync cannot rematerialize documents, GL, files, or PDFs", () => {
  assert.match(financialSync, /update time_entries/i);
  assert.match(financialSync, /update projects/i);
  assert.doesNotMatch(
    financialSync,
    /(?:update|insert into|delete from)\s+(?:documents|document_lines|journal_entries|journal_lines|files|file_versions|invoice_backups)\b/i,
  );
});
