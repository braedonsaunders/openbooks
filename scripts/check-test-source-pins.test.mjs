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

test("a local read helper and bindings through it count as source pins", () => {
  const viaHelper = src([
    'const read = (path: string) => READ(new URL(path, import.meta.url), "utf8");',
    'const tools = read("./tools.ts");',
    'test("pins module binding", () => {',
    "  assert.match(tools, /feature: \"orders\"/);",
    "});",
    'test("pins call inside the test", () => {',
    "  const route = read('./route.ts');",
    "  assert.match(route, /guardFeaturePermission/);",
    "});",
    'test("behaviour", () => { assert.equal(1, 1); });',
  ]);
  assert.deepEqual(sourcePinTests(viaHelper).map((pin) => pin.name), [
    "pins module binding",
    "pins call inside the test",
  ]);
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

test("the read is followed through slices, splits, templates, helpers and collected verdicts", () => {
  const cases = {
    "multi-line read, sliced by position": [
      'const PANEL = READ(',
      '  new URL("../app/documents/SharePanel.tsx", import.meta.url),', // source-path: synthetic
      '  "utf8",',
      ");",
      'test("t", () => {',
      '  const load = PANEL.slice(PANEL.indexOf("function load"), PANEL.indexOf("useEffect"));',
      "  assert.match(load, /setLoadError/);",
      "});",
    ],
    "split, destructured, and tested line by line": [
      'const [head, ...lines] = READ("web/lib/x.ts", "utf8").split("\\n");',
      'test("t", () => { assert.ok(lines.some((line) => /guard\\(/.test(line))); });',
    ],
    "interpolated into a template": [
      'const a = READ("a.ts", "utf8");',
      'test("t", () => { const both = `${a}\\n`; assert.ok(both.includes("x")); });',
    ],
    "same-file slicing and asserting helpers": [
      'const section = (src: string, from: string) => src.slice(src.indexOf(from));',
      "function requireGuard(text: string) { assert.match(text, /guard/); }",
      'test("t", () => { requireGuard(section(READ("route.ts", "utf8"), "export")); });',
    ],
    "offenders collected under a condition over the text of a walked listing": [
      'const dir = "web/app/api";',
      'test("t", () => {',
      "  const offenders: string[] = [];",
      '  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".ts"))) {',
      '    if (!READ(join(dir, name), "utf8").includes("guard(")) offenders.push(name);',
      "  }",
      "  assert.deepEqual(offenders, []);",
      "});",
    ],
  };
  for (const [shape, lines] of Object.entries(cases)) {
    assert.deepEqual(sourcePinTests(src(lines)).map((pin) => pin.name), ["t"], shape);
  }
});

test("text that is executed, a local reader, and a directory named by a source file are not pins", () => {
  const cases = {
    "a migration run inside an assertion callback": [
      'const body = READ("schema/migrations/generated/0001_x.sql", "utf8");',
      'test("t", async () => { await assert.rejects(() => tx.execute(sql.raw(body)), /refused/); });',
    ],
    "an SFTP helper that happens to be called readFile": [
      "function readFile(sftp: Sftp, path: string) { return sftp.get(path); }",
      'test("t", async () => { assert.deepEqual(await readFile(sftp, "out/report.ts"), BYTES); });',
    ],
    "a data file beside a source file": [
      'const root = dirname(fileURLToPath(new URL("./trust-badge.mjs", import.meta.url)));',
      'test("t", () => { assert.match(READ(join(root, "badge.json"), "utf8"), /passing/); });',
    ],
  };
  for (const [shape, lines] of Object.entries(cases)) {
    assert.deepEqual(sourcePinTests(src(lines)), [], shape);
  }
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
