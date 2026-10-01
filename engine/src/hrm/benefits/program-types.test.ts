import assert from "node:assert/strict";
import test from "node:test";
import {
  BENEFIT_ALLOCATIONS,
  BENEFIT_AWARD_STATUSES,
  BENEFIT_DELIVERY_METHODS,
  BENEFIT_FREQUENCIES,
  BENEFIT_METRICS,
  BENEFIT_METRIC_SCOPES,
  BENEFIT_PERIOD_BASES,
  BENEFIT_PROGRAM_FAMILIES,
  BENEFIT_PROGRAM_STATUSES,
  BENEFIT_VALUATIONS,
  PROGRAM_STATUS_TRANSITIONS,
} from "./program-types.ts";
import {
  BENEFIT_AWARD_STATUSES as SCHEMA_AWARD_STATUSES,
  BENEFIT_PROGRAM_ALLOCATIONS as SCHEMA_ALLOCATIONS,
  BENEFIT_PROGRAM_DELIVERY as SCHEMA_DELIVERY,
  BENEFIT_PROGRAM_FAMILIES as SCHEMA_FAMILIES,
  BENEFIT_PROGRAM_FREQUENCIES as SCHEMA_FREQUENCIES,
  BENEFIT_PROGRAM_METRICS as SCHEMA_METRICS,
  BENEFIT_PROGRAM_PERIOD_BASES as SCHEMA_PERIOD_BASES,
  BENEFIT_PROGRAM_SCOPES as SCHEMA_SCOPES,
  BENEFIT_PROGRAM_STATUSES as SCHEMA_STATUSES,
  BENEFIT_PROGRAM_VALUATION as SCHEMA_VALUATION,
} from "@openbooks/schema/src/benefits-programs.ts";

/**
 * Program vocabulary: one source of truth. The engine re-exports the schema
 * lists, so a renamed family, status, or metric cannot strand one layer on
 * the old word while the storage CHECK enforces the new one.
 */
test("engine program vocabulary matches the schema source of truth", () => {
  assert.deepEqual([...BENEFIT_PROGRAM_FAMILIES], [...SCHEMA_FAMILIES]);
  assert.deepEqual([...BENEFIT_PROGRAM_STATUSES], [...SCHEMA_STATUSES]);
  assert.deepEqual([...BENEFIT_DELIVERY_METHODS], [...SCHEMA_DELIVERY]);
  assert.deepEqual([...BENEFIT_VALUATIONS], [...SCHEMA_VALUATION]);
  assert.deepEqual([...BENEFIT_METRICS], [...SCHEMA_METRICS]);
  assert.deepEqual([...BENEFIT_METRIC_SCOPES], [...SCHEMA_SCOPES]);
  assert.deepEqual([...BENEFIT_ALLOCATIONS], [...SCHEMA_ALLOCATIONS]);
  assert.deepEqual([...BENEFIT_FREQUENCIES], [...SCHEMA_FREQUENCIES]);
  assert.deepEqual([...BENEFIT_PERIOD_BASES], [...SCHEMA_PERIOD_BASES]);
  assert.deepEqual([...BENEFIT_AWARD_STATUSES], [...SCHEMA_AWARD_STATUSES]);
});

test("program status moves close the loop: drafts activate, active close", () => {
  assert.deepEqual([...PROGRAM_STATUS_TRANSITIONS.draft], ["active"]);
  assert.deepEqual([...PROGRAM_STATUS_TRANSITIONS.active], ["closed"]);
  assert.deepEqual([...PROGRAM_STATUS_TRANSITIONS.closed], []);
});
