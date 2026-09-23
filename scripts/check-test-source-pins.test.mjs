import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, scanTree, sourcePinTests } from "./check-test-source-pins.mjs";
import { readFileSync } from "node:fs";

// Fixture sources spell the reader as READ and swap it in at runtime, so this
// file's own text never looks like a source pin to the checker it tests.
const src = (lines) => lines.join("\n").replaceAll("READ", "readFile" + "Sync");

const pinned = src([
  'import { readFileSync } from "node:fs";',
  'const routeSource = READ(new URL("./route.ts", import.meta.url), "utf8");', // source-path: synthetic
  'test("guard exists", () => {',
  "  assert.match(routeSource, /guardSubsidiaryScope\\(authz/);",
  "});",
  'test("behaviour", async () => {',
  "  assert.equal(await handler(req), 404);",
  "});",
]);

test("a test asserting on source text is a pin; a behaviour test beside it is not", () => {
  assert.deepEqual(sourcePinTests(pinned).map((pin) => pin.name), ["guard exists"]);
});

test("inline reads, includes and indexOf over source text are pins too", () => {
  const inline = src([
    'test("inline", () => {',
    '  const text = READ("web/app/page.tsx", "utf8");',
    '  assert.ok(text.includes("statTile({"));',
    "});",
  ]);
  assert.equal(sourcePinTests(inline).length, 1);
});

test("fixture and data reads are not source pins", () => {
  const fixture = src([
    'const golden = READ("engine/src/payroll/__fixtures__/w2.sql", "utf8");',
    'test("parses", () => { assert.match(golden, /W-2/); });',
  ]);
  assert.deepEqual(sourcePinTests(fixture), []);
});

test("a declared contract exempts the file, and the declaration must say what the contract is", () => {
  const declared = `// source-pin-contract: CI release trigger policy is the behaviour under test\n${pinned}`;
  assert.deepEqual(sourcePinTests(declared), []);
  const vague = `// source-pin-contract: policy\n${pinned}`;
  assert.equal(sourcePinTests(vague).length, 1);
});

test("the ratchet refuses new pins and growth, and makes shrinkage stick", () => {
  assert.deepEqual(reconcile({ "a.test.ts": 2 }, { "a.test.ts": 2 }), []);
  assert.match(reconcile({ "new.test.ts": 1 }, {})[0], /new source-pin test/);
  assert.match(reconcile({ "a.test.ts": 3 }, { "a.test.ts": 2 })[0], /Do not add more/);
  assert.match(reconcile({ "a.test.ts": 1 }, { "a.test.ts": 2 })[0], /Lower the entry/);
  assert.match(reconcile({}, { "a.test.ts": 2 })[0], /delete it/);
});

test("the committed tree matches the committed burn-down list", () => {
  const allowlist = JSON.parse(readFileSync("scripts/test-source-pins.allowlist.json", "utf8")).files;
  assert.deepEqual(reconcile(scanTree(), allowlist), []);
});
