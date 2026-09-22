import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./open-items.ts", import.meta.url), "utf8");

test("open-item list reuses the cash reader and keeps remaining as an exact decimal", () => {
  assert.match(SOURCE, /from "\.\.\/cash\/open-items"/);
  assert.match(SOURCE, /normalizeMoneyValue\(String\(item\.remaining\)\)/);
  assert.doesNotMatch(SOURCE, /\bnum\(/);
  assert.match(SOURCE, /side is required; use ar or ap/);
});
