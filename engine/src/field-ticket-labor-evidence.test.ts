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

test("the source certificate is exhaustive rather than sampled", () => {
  const verifier = readFileSync(
    "engine/src/validation/verify-field-ticket-labor-evidence.ts",
    "utf8",
  );
  assert.match(verifier, /for \(const \[key, hours\] of expected\)/);
  assert.match(verifier, /for \(const \[key, hours\] of actual\)/);
  assert.match(verifier, /ticketHashMismatches/);
  assert.match(verifier, /certified:\s*failureCount === 0/);
});

test("time semantics are explicit and snapshotted independently from rates", () => {
  const schema = readFileSync("schema/src/documents.ts", "utf8");
  const evidenceSchema = readFileSync("schema/src/field-tickets.ts", "utf8");
  const pdf = readFileSync("web/lib/pdf-templates/values.ts", "utf8");
  assert.match(schema, /classification[\s\S]*regular[\s\S]*overtime[\s\S]*double_time[\s\S]*other/);
  assert.match(evidenceSchema, /timeClassification:\s*text\("time_classification"/);
  assert.match(pdf, /tier\(e\.time_classification\)/);
  assert.doesNotMatch(pdf, /tier\(e\.bill_multiplier\)/);
});
