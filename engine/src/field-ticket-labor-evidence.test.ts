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
  const baseline = readFileSync(
    "schema/migrations/generated/0001_baseline.sql",
    "utf8",
  );
  assert.match(baseline, /field_ticket_labor_snapshots_current[\s\S]*where \(superseded_at IS NULL\)/i);
  assert.match(baseline, /field_ticket_labor_snapshot_retention_guard/i);
  assert.match(baseline, /field_ticket_labor_line_immutable_guard/i);
  assert.match(baseline, /force row level security/gi);
  assert.match(baseline, /time-entry provenance must be an exact line on the same ticket/i);
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
