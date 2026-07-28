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
});

test("project-financial input sync cannot rematerialize documents, GL, files, or PDFs", () => {
  assert.match(financialSync, /update time_entries/i);
  assert.match(financialSync, /update projects/i);
  assert.doesNotMatch(
    financialSync,
    /(?:update|insert into|delete from)\s+(?:documents|document_lines|journal_entries|journal_lines|files|file_versions|invoice_backups)\b/i,
  );
});
