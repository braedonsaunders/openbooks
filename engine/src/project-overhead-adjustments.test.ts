import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "schema/migrations/generated/0081_project_overhead_adjustments.sql",
  "utf8",
);
const service = readFileSync(
  "engine/src/project-overhead-adjustments.ts",
  "utf8",
);
const resolver = readFileSync("web/lib/project-financials.ts", "utf8");

test("statistical overhead exceptions are native immutable evidence", () => {
  assert.match(migration, /project_overhead_adjustments/i);
  assert.match(migration, /append-only/i);
  assert.match(migration, /reversing adjustment/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /force row level security/i);
  assert.match(service, /source identity/i);
  assert.match(service, /insert into audit_log/i);
});

test("the configurable overhead result includes explicit adjustments", () => {
  assert.match(resolver, /from project_overhead_adjustments/i);
  assert.match(
    resolver,
    /add\(calculatedOverhead, overheadAdjustment\)/i,
  );
  assert.doesNotMatch(resolver, /rassaun|account\\s*500/i);
});
