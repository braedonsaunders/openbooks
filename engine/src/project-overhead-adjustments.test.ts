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

test("the configurable overhead result includes explicit adjustments", () => {
  assert.match(resolver, /from project_overhead_adjustments/i);
  assert.match(
    resolver,
    /add\(calculatedOverhead, overheadAdjustment\)/i,
  );
  const tenantName = ["Ras", "saun"].join("");
  assert.doesNotMatch(resolver, new RegExp(`${tenantName}|account\\s*500`, "i"));
});
