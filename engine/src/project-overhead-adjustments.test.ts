import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const baseline = readFileSync(
  "schema/migrations/generated/0001_baseline.sql",
  "utf8",
);
const service = readFileSync(
  "engine/src/project-overhead-adjustments.ts",
  "utf8",
);
const schema = readFileSync(
  "schema/src/project-overhead-adjustments.ts",
  "utf8",
);
const reversalMigration = readFileSync(
  "schema/migrations/generated/0077_project_overhead_adjustment_reversal_uniqueness.sql",
  "utf8",
);
const resolver = readFileSync("engine/src/project-financials.ts", "utf8");

test("statistical overhead exceptions are native immutable evidence", () => {
  assert.match(baseline, /project_overhead_adjustments/i);
  assert.match(baseline, /append-only/i);
  assert.match(baseline, /reversing adjustment/i);
  assert.match(baseline, /enable row level security/i);
  assert.match(baseline, /force row level security/i);
  assert.match(service, /source identity/i);
  assert.match(service, /insert into audit_log/i);
});

test("recordProjectOverheadAdjustment persists amount through canonicalDecimal then normalizeMoney", () => {
  const helperStart = service.indexOf("function persistOverheadAdjustmentAmount");
  const helperEnd = service.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistOverheadAdjustmentAmount helper is defined");
  const helper = service.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /must be an exact decimal/);

  const start = service.indexOf("export async function recordProjectOverheadAdjustment");
  const next = service.indexOf("export async function reverseProjectOverheadAdjustment");
  const body = service.slice(start, next);
  assert.match(body, /persistOverheadAdjustmentAmount\(input\.amount\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.amount\)/);
});

test("project overhead reversals are unique, replay-safe, and fail closed on legacy duplicates", () => {
  assert.match(
    schema,
    /uniqueIndex\("project_overhead_adjustments_one_reversal"\)[\s\S]*\.on\(t\.orgId, t\.reversesAdjustmentId\)[\s\S]*\.where\(sql`\$\{t\.reversesAdjustmentId\} is not null`\)/,
  );
  assert.match(
    reversalMigration,
    /DO \$project_overhead_adjustment_reversal_preflight\$[\s\S]*string_agg\(id::text, ', ' ORDER BY id\)[\s\S]*GROUP BY org_id, reverses_adjustment_id[\s\S]*ORDER BY org_id, reverses_adjustment_id[\s\S]*RAISE EXCEPTION[\s\S]*USING ERRCODE = '23505'/i,
  );
  assert.match(
    reversalMigration,
    /CREATE UNIQUE INDEX IF NOT EXISTS project_overhead_adjustments_one_reversal[\s\S]*\(org_id, reverses_adjustment_id\)[\s\S]*WHERE reverses_adjustment_id IS NOT NULL/i,
  );
});

test("reversal retries lock the source, return identical evidence, and reject mismatches", () => {
  const start = service.indexOf("export async function reverseProjectOverheadAdjustment");
  assert.ok(start >= 0, "reverseProjectOverheadAdjustment is defined");
  const body = service.slice(start);
  const sourceLock = body.indexOf("where org_id = ${input.orgId} and id = ${input.adjustmentId}");
  const reversalCheck = body.indexOf("reverses_adjustment_id = ${input.adjustmentId}");
  const insert = body.indexOf("recordProjectOverheadAdjustmentWithinTransaction");
  assert.ok(sourceLock >= 0, "the source adjustment is loaded");
  assert.ok(body.indexOf("for update", sourceLock) > sourceLock, "the source adjustment is row-locked");
  assert.ok(reversalCheck > sourceLock, "the existing reversal is checked after locking the source");
  assert.ok(insert > reversalCheck, "a new reversal is appended only after the duplicate check");
  assert.match(body, /existing: true/);
  assert.match(body, /already has a reversal with different evidence/);
});

test("the configurable overhead result includes explicit adjustments", () => {
  assert.match(resolver, /from project_overhead_adjustments/i);
  assert.match(
    resolver,
    /add\(calculatedOverhead, overheadAdjustment\)/i,
  );
  const tenantName = ["Ras", "saun"].join("");
  assert.doesNotMatch(resolver, new RegExp(`${tenantName}|account\\s*500`, "i"));
});
