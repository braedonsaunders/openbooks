import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./v1-records.ts", import.meta.url), "utf8");

test("pretty-path aliases refuse reserved folders before touching records", () => {
  assert.match(SOURCE, /V1_RESERVED_STATIC_SEGMENTS/);
  for (const name of [
    "v1ListAliasedRecords",
    "v1CreateAliasedRecord",
    "v1GetAliasedRecord",
    "v1UpdateAliasedRecord",
    "v1DeleteAliasedRecord",
  ]) {
    const start = SOURCE.indexOf(`export function ${name}`);
    assert.ok(start >= 0, name);
    const fn = SOURCE.slice(start, start + 500);
    assert.match(fn, /assertAliasedTypeKey/);
    assert.ok(
      fn.indexOf("assertAliasedTypeKey") < fn.search(/listRecords|createApplicationRecord|getRecord|updateApplicationRecord|deleteApplicationRecord/),
      `${name} must refuse reserved keys before the application records call`,
    );
  }
});
