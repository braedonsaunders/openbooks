import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./project-financial-profile-versions.ts", import.meta.url),
  "utf8",
);

test("canonicalizeProjectFinancialProfile persists policy rates through canonicalDecimal then normalizeMoney", () => {
  const helperStart = source.indexOf("function persistProjectPolicyDecimal");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistProjectPolicyDecimal helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /must be a finite non-negative decimal/);
  assert.doesNotMatch(helper, /normalizeDecimal\(value/);

  const start = source.indexOf("export function canonicalizeProjectFinancialProfile");
  const next = source.indexOf("export function assertValidProjectFinancialProfile");
  const body = source.slice(start, next);
  assert.match(body, /optionalNonnegativeDecimal\(/);
  assert.doesNotMatch(body, /normalizeDecimal\(/);
  assert.doesNotMatch(body, /normalizeMoney\(/);
});
