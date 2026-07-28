import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "engine/src/validation/project-parity-certificate.ts",
  "utf8",
);

test("project GL parity uses source posted accounting lines", () => {
  assert.match(source, /from transactionaccountingline tal/i);
  assert.match(source, /sum\(tal\.amount\) as amount/i);
  assert.doesNotMatch(
    source,
    /sum\(tl\.netamount\) as amount/i,
    "commercial transaction-line netamount is not authoritative GL impact",
  );
});

test("invoice-line fallback rates use canonical commercial precision", () => {
  assert.match(
    source,
    /source\.rate == null[\s\S]*canonicalDecimal\(expectedAmount\)/,
  );
});

test("multi-book source GL requires an explicit accounting-book choice", () => {
  assert.match(source, /--source-accounting-book=<id> explicitly/);
  assert.match(source, /source project GL artifact spans accounting books/);
  assert.match(source, /row\.accountingbook\) === sourceAccountingBook/);
});

test("project financial certification is effective-dated and penny exact", () => {
  assert.match(source, /--as-of must be YYYY-MM-DD/);
  assert.match(
    source,
    /loadProjectType\(\s*orgId,\s*String\(project\.id\),\s*financialAsOf/,
  );
  assert.match(source, /function pennyEqual/);
  assert.match(source, /source\.grossProfit == null/);
  assert.match(source, /source\.couldBeInvoiced != null/);
  assert.match(source, /source\.overhead != null/);
  assert.match(source, /\["40P01", "40001"\]\.includes\(code\)/);
  assert.match(
    source,
    /const \{ projectType, financials \} = await retry\(async \(\) =>/,
  );
});

test("strict certification binds fresh artifacts to one complete source population", () => {
  assert.match(source, /connectorWatermark/);
  assert.match(source, /max-sync-lag-minutes/);
  assert.match(
    source,
    /certificateStartedAt\.getTime\(\) - completedAt/,
    "the 24-hour operational SLA is based on run completion, not a source-local watermark timestamp",
  );
  assert.match(source, /latest connector attempt/);
  assert.match(source, /kind in \('incremental', 'full_migration'\)/);
  assert.match(source, /sourceSnapshotCoherence/);
  assert.match(source, /project-financial identities do not equal the source project population/);
  assert.match(source, /project-financial artifact lacks a valid fetchedAt for every project/);
  assert.match(source, /source snapshot is older than/);
  assert.match(source, /hash changed after source capture/);
});

test("invoice parity covers business identity and settlement state, not only totals", () => {
  for (const field of [
    "document_number",
    "document_date",
    "party",
    "status",
    "total",
    "open_balance",
  ]) {
    assert.match(source, new RegExp(`\"${field}\"`));
  }
  assert.match(source, /foreignamountunpaid/);
  assert.match(
    source,
    /sourceInvoicesWithLedgerImpact\.has\(sourceRef\)[\s\S]*"posted"[\s\S]*"approved"/,
    "zero-ledger source invoices are finalized as approved without manufacturing a zero-value journal",
  );
});

test("Field Ticket parity follows the labor source of truth for each lifecycle", () => {
  assert.match(source, /join field_ticket_labor_snapshots snapshot/i);
  assert.match(source, /join field_ticket_labor_lines line/i);
  assert.match(source, /snapshot\.superseded_at is null/i);
  assert.match(source, /snapshot\.evidence_basis = 'source_import'/i);
  assert.match(
    source,
    /d\.status = 'approved'[\s\S]*union all[\s\S]*join time_entries time/i,
  );
  assert.match(
    source,
    /join time_entries time[\s\S]*d\.status = 'draft'/i,
    "only draft tickets may be certified directly from editable time",
  );
});
