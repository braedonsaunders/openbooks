import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./sync.ts", import.meta.url), "utf8");

test("insertImportedLines persists document-line quantity and unitPrice through canonicalDecimal then normalizeMoney", () => {
  const helperStart = source.indexOf("function persistSyncLineMoney");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSyncLineMoney helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /must be an exact decimal/);

  const fn = source.indexOf("async function insertImportedLines");
  const next = source.indexOf("async function runSync(");
  const body = source.slice(fn, next > fn ? next : undefined);
  assert.match(body, /persistSyncLineMoney\(line\.quantity \?\? "1", "quantity"\)/);
  assert.match(body, /persistSyncLineMoney\(line\.unitPrice \?\? line\.amount, "unit price"\)/);
  assert.doesNotMatch(body, /normalizeDecimal\(line\.unitPrice \?\? line\.amount, 8\)/);
  assert.doesNotMatch(body, /quantity: line\.quantity \?\? "1"/);
});

test("insertImportedLines persists document-line amount, taxAmount, and billAmount through persistSyncLineMoney", () => {
  const fn = source.indexOf("async function insertImportedLines");
  const next = source.indexOf("async function runSync(");
  const body = source.slice(fn, next > fn ? next : undefined);
  assert.match(body, /persistSyncLineMoney\(line\.amount, "amount"\)/);
  assert.match(body, /persistSyncLineMoney\(line\.taxAmount, "tax amount"\)/);
  assert.match(body, /line\.billAmount == null \? null : persistSyncLineMoney\(line\.billAmount, "bill amount"\)/);
  assert.doesNotMatch(body, /amount: normalizeMoney\(line\.amount\)/);
  assert.doesNotMatch(body, /taxAmount: normalizeMoney\(line\.taxAmount\)/);
  assert.doesNotMatch(body, /billAmount: line\.billAmount == null \? null : normalizeMoney\(line\.billAmount\)/);
});
