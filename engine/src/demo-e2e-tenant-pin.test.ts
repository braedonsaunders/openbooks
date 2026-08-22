import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./demo-e2e.ts", import.meta.url), "utf8");

test("demo e2e document memo write pins the known tenant on the id update", () => {
  assert.match(
    source,
    /update\(schema\.documents\)[\s\S]*?where\(and\(eq\(schema\.documents\.id, doc\.id\), eq\(schema\.documents\.orgId, orgId\)\)\)/,
  );
});
