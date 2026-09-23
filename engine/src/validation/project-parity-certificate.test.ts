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

test("every consumed artifact is hash-bound through one shared list", () => {
  for (const key of [
    "sourceProjects",
    "sourceInvoices",
    "sourceInvoiceLines",
    "sourceProjectGl",
    "sourceProjectFinancials",
    "fieldTicketHeaders",
    "fieldTicketCrew",
  ]) {
    assert.match(
      source,
      new RegExp(`"${key}"`),
      `${key} must belong to the single consumed-artifact list`,
    );
  }
  assert.match(source, /const CONSUMED_SOURCE_ARTIFACT_KEYS = \[/);
  assert.match(
    source,
    /for \(const \{ key, path, sha256 \} of consumed\)/,
    "coherence verifies the same consumed list the comparison reads",
  );
  assert.match(
    source,
    /has no capture hash; re-run with --refresh-source/,
    "an artifact with no capture hash refuses by name",
  );
  assert.match(
    source,
    /was captured at .* but is now missing/,
    "a captured file that vanished reads as tampering, not absence",
  );
  assert.match(
    source,
    /All \$\{verifiedArtifacts\.length\} consumed source artifacts/,
    "the hash-bound claim derives from the verified list",
  );
});

test("the capture manifest records every consumed artifact", () => {
  assert.match(
    source,
    /for \(const \{ key, path, sha256 \} of consumedArtifactFiles\(paths\)\)/,
    "refresh hashes the shared consumed list, not a hand-kept subset",
  );
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
  assert.match(source, /--field-ticket-source-system/);
  assert.match(source, /--source-id-key/);
  assert.match(source, /snapshot\.source_system = \$\{fieldTicketSourceSystem/);
  assert.doesNotMatch(source, /snapshot\.source_system = '[^']+'/);
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
