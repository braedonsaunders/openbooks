import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fieldTicketLaborLines, timeTypes } from "@openbooks/schema";
import {
  captureFieldTicketLaborEvidence,
  FieldTicketLaborEvidenceError,
} from "./field-ticket-labor-evidence.ts";

test("commercial labor evidence cannot mutate the operational time ledger", () => {
  const service = readFileSync(
    "engine/src/projects/field-ticket-labor-evidence.ts",
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

test("an impossible calendar date refuses by name before any database cast", async () => {
  // ISO_DATE is shape-only: 2026-02-30 passes the regex and used to reach
  // (workedOn)::date, throwing a raw Postgres error instead of the named
  // refusal. Validation runs before withOrg, so this needs no database.
  const line = {
    employeePartyId: "11111111-1111-4111-8111-111111111111",
    employeeName: "Sam",
    timeTypeId: "22222222-2222-4222-8222-222222222222",
    timeTypeName: "Regular",
    timeClassification: "regular" as const,
    workedOn: "2026-02-30",
    hours: "2",
  };
  await assert.rejects(
    captureFieldTicketLaborEvidence({
      orgId: "33333333-3333-4333-8333-333333333333",
      fieldTicketId: "44444444-4444-4444-8444-444444444444",
      actorId: "55555555-5555-4555-8555-555555555555",
      evidenceBasis: "operational_time",
      reason: "approval capture",
      currency: "USD",
      lines: [line],
    }),
    (error: unknown) => {
      assert.ok(error instanceof FieldTicketLaborEvidenceError);
      assert.match(error.message, /labor line 1/);
      assert.match(error.message, /2026-02-30/);
      return true;
    },
  );
});

test("time semantics share one classification contract across time types and evidence lines", () => {
  // Behavioural cover for tier-by-classification (crew grid buckets by
  // classification, never by multiplier).
  assert.deepEqual([...(timeTypes.classification.enumValues ?? [])], ["regular", "overtime", "double_time", "other"]);
  assert.deepEqual([...(fieldTicketLaborLines.timeClassification.enumValues ?? [])], ["regular", "overtime", "double_time", "other"]);
});
