import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../../lib/client-scripts.ts", import.meta.url), "utf8");

test("client-script iframe stays opaque-origin (allow-scripts only)", () => {
  assert.match(source, /iframe\.setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.doesNotMatch(source, /allow-same-origin/);
  assert.doesNotMatch(source, /allow-top-navigation/);
  assert.doesNotMatch(source, /allow-forms/);
  assert.match(source, /sandbox="allow-scripts"/);
});
