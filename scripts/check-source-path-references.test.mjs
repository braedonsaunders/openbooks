import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { analyze, segmentReferences, stripComments } from "./check-source-path-references.mjs";

// Fixture file bodies live in fixtures/source-path-references/*.txt, not as
// string literals here: they contain readFileSync/new-URL/regex shapes as
// TEST DATA for analyze(), and inline literals would misread as assertions
// on repository source. The temp repo below is still assembled with real .ts
// names, so every shape resolves exactly as the literals did.
function fixture(name) {
  return readFileSync(new URL(`./fixtures/source-path-references/${name}.txt`, import.meta.url), "utf8");
}

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
    "web/lib/ok.test.ts": fixture("ok"),
    "web/lib/stale.test.ts": fixture("stale"),
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
    "web/lib/intent.test.ts": fixture("intent"),
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
