import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "validate.ts"), "utf8");

test("generic API number coerce persists through canonicalDecimal then normalizeMoney", () => {
  assert.match(source, /canonicalDecimal\(raw, 4\)/);
  assert.match(source, /normalizeMoney\(exact\)/);
  assert.match(source, /must be a number/);
});
