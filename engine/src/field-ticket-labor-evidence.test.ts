import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("commercial labor evidence cannot mutate the operational time ledger", () => {
  const service = readFileSync(
    "engine/src/field-ticket-labor-evidence.ts",
    "utf8",
  );
  assert.doesNotMatch(service, /\b(?:insert\s+into|update|delete\s+from)\s+time_entries\b/i);
  assert.match(service, /operationalTimeStatusUnchanged:\s*true/);
  assert.match(service, /for update of d, ft/i);
});

test("labor evidence is revisioned, tenant-scoped, and append-only", () => {
  const migration = readFileSync(
    "schema/migrations/generated/0075_field_ticket_labor_evidence.sql",
    "utf8",
  );
  assert.match(migration, /field_ticket_labor_snapshots_current[\s\S]*where superseded_at is null/i);
  assert.match(migration, /field_ticket_labor_snapshot_retention_guard/i);
  assert.match(migration, /field_ticket_labor_line_immutable_guard/i);
  assert.match(migration, /force row level security/gi);
  assert.match(migration, /time-entry provenance must be an exact line on the same ticket/i);
});

test("source evidence import cannot create or relink time entries", () => {
  const importer = readFileSync(
    "engine/src/validation/import-field-ticket-labor-evidence.ts",
    "utf8",
  );
  assert.doesNotMatch(importer, /\b(?:insert\s+into|update|delete\s+from)\s+time_entries\b/i);
  assert.match(importer, /operationalTimeRowsMutated:\s*0/);
  assert.match(importer, /supersedeCurrent:\s*true/);
});
