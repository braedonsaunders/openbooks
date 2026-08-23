import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./depreciation.ts", import.meta.url), "utf8");

test("recordDepreciationInput persists value through canonicalDecimal then normalizeMoney", () => {
  const helperStart = source.indexOf("function persistDepreciationInputValue");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistDepreciationInputValue helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /depreciation value must be an exact decimal/);

  const fn = source.indexOf("export async function recordDepreciationInput");
  const next = source.indexOf("return db.transaction", fn);
  const body = source.slice(fn, next > fn ? next : undefined);
  assert.match(body, /persistDepreciationInputValue\(args\.value\)/);
  assert.doesNotMatch(body, /normalizeMoney\(args\.value\)/);
});
