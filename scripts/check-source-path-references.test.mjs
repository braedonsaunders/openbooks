import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyze, segmentReferences, stripComments } from "./check-source-path-references.mjs";

// The check lists files through git, so the fixture is a real repository.
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "source-paths-"));
  execFileSync("git", ["init", "-q", root]);
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  execFileSync("git", ["-C", root, "add", "-A"]);
  return root;
}

const ENGINE = { "engine/src/crm/crm.ts": "export const x = 1;\n", "engine/src/coins/coins.ts": "export const y = 1;\n" };

test("segment-assembled, new URL and escaped regex references that resolve pass; each stale shape is named with its line", () => {
  const root = repo({
    ...ENGINE,
    "web/lib/ok.test.ts": [
      'const a = readFileSync(join(here, "..", "..", "engine", "src", "crm", "crm.ts"), "utf8");',
      'const b = readFileSync(new URL("../../engine/src/coins/coins.ts", import.meta.url), "utf8");', // source-path: synthetic
      "assert.match(a, /engine\\/src\\/crm\\/crm\\.ts/);",
      "",
    ].join("\n"),
    "web/lib/stale.test.ts": [
      'const a = readFileSync(join(here, "..", "..", "engine", "src", "gone.ts"), "utf8");', // source-path: synthetic
      "const b = join(",
      '  import.meta.dirname, "..", "..", "engine", "src", "vanished.ts",', // source-path: synthetic
      ");",
      'const c = readFileSync(new URL("../../engine/src/coins.ts", import.meta.url), "utf8");', // source-path: synthetic
      "assert.match(a, /from \"@openbooks\\/engine\\/src\\/coins\\.ts\"/);",
      "",
    ].join("\n"),
  });
  try {
    const { problems, checked } = analyze(root);
    assert.equal(checked, 7, problems.join("\n"));
    assert.deepEqual(
      problems.map((p) => p.split(" does not exist")[0]),
      [
        'web/lib/stale.test.ts:1: segment-assembled path "engine/src/gone.ts"',
        'web/lib/stale.test.ts:3: segment-assembled path "engine/src/vanished.ts"',
        'web/lib/stale.test.ts:5: new URL() path "engine/src/coins.ts"',
        'web/lib/stale.test.ts:6: escaped regex path "engine/src/coins.ts"',
      ],
    );
    assert.match(problems[0], /point the reference at its current path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a synthetic path is opted out on its line; an absence assertion and a commented example are never stale", () => {
  const root = repo({
    ...ENGINE,
    "web/lib/intent.test.ts": [
      "assert.match(out, /created  engine\\/src\\/payroll\\/rates-2099\\.ts/); // source-path: synthetic",
      'assert.equal(existsSync(new URL("./Gone.tsx", import.meta.url)), false);',
      '// const old = readFileSync(join(here, "engine", "src", "gone.ts"));', // source-path: synthetic
      "/* new URL(\"../engine/src/coins.ts\", import.meta.url) used to be the way */",
      "",
    ].join("\n"),
  });
  try {
    const { problems, checked } = analyze(root);
    assert.deepEqual(problems, []);
    assert.equal(checked, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("segmentReferences reads quoted segments across line breaks and stops at the first non-segment", () => {
  const refs = segmentReferences('join(root,\n  "engine",\n  "src",\n  "payroll", "run-lifecycle.ts",\n) + other("engine", "x")');
  assert.deepEqual(refs.map((r) => r.path), ["engine/src/payroll/run-lifecycle.ts"]);
});

test("stripComments keeps line structure", () => {
  const source = "a\n/* b\nc */ d\n// e\nf";
  assert.equal(stripComments(source).split("\n").length, 5);
  assert.match(stripComments(source), /^a\n\s+d\n\s*\nf$/);
});
