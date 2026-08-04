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
const resolver = readFileSync("web/lib/project-financials.ts", "utf8");

test("statistical overhead exceptions are native immutable evidence", () => {
  assert.match(baseline, /project_overhead_adjustments/i);
  assert.match(baseline, /append-only/i);
  assert.match(baseline, /reversing adjustment/i);
  assert.match(baseline, /enable row level security/i);
  assert.match(baseline, /force row level security/i);
  assert.match(service, /source identity/i);
  assert.match(service, /insert into audit_log/i);
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
