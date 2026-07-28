import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "schema/migrations/generated/0078_time_entry_billing_status.sql",
  "utf8",
);
const financialSync = readFileSync(
  "engine/src/sync/project-financial-inputs.ts",
  "utf8",
);
const costingMigration = readFileSync(
  "schema/migrations/generated/0080_time_entry_costing_basis.sql",
  "utf8",
);
const projectFinancials = readFileSync(
  "web/lib/project-financials.ts",
  "utf8",
);

test("time billing is a native lifecycle independent of invoice-line linkage", () => {
  assert.match(migration, /billing_status text not null default 'unbilled'/i);
  assert.match(
    migration,
    /invoiced_by_line_id is null or billing_status = 'billed'/i,
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
    /const billableValue = add\(totalTimeBill, totalLineBill\)/i,
  );
  assert.doesNotMatch(
    projectFinancials,
    /const billableValue = add\(invoicedToDate, unbilledBillable\)/i,
  );
});

test("time costing distinguishes actualized labor from estimates", () => {
  assert.match(
    costingMigration,
    /costing_basis text not null default 'actual'/i,
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

test("project-financial input sync cannot rematerialize documents, GL, files, or PDFs", () => {
  assert.match(financialSync, /update time_entries/i);
  assert.match(financialSync, /update projects/i);
  assert.doesNotMatch(
    financialSync,
    /(?:update|insert into|delete from)\s+(?:documents|document_lines|journal_entries|journal_lines|files|file_versions|invoice_backups)\b/i,
  );
});
