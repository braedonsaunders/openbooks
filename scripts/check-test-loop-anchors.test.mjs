import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanFile, scanTree } from "./check-test-loop-anchors.mjs";

function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "openbooks-loops-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

test("pinned, derived, and literal loops pass; bare row loops fail", () => {
  const root = fixtureTree({
    "engine/src/ok.integration.test.ts": `import assert from "node:assert/strict";
import test from "node:test";
test("length pinned", async () => {
  const rows = (await db.execute(sql\`select id\`)).rows;
  assert.equal(rows.length, 2);
  for (const row of rows) assert.ok(row.id);
});
test("some/every derivation", async () => {
  for (const row of rows) assert.ok(row.ok);
  assert.ok(rows.some((row) => row.ok));
});
test("typed literal", async () => {
  const cells: Array<{ run: () => number }> = [{ run: () => 1 }];
  for (const cell of cells) assert.ok(await cell.run());
});
test("deepEqual against a non-empty literal", async () => {
  const rows = (await db.execute(sql\`select id\`)).rows;
  assert.deepEqual(rows.map((row) => row.id), ["a", "b"]);
  for (const row of rows) assert.ok(row.id);
});
test("as-const tuple and deepEqual literal", async () => {
  for (const [set, entry] of [[["a"], "e1"], [["b"], "e2"]] as const) {
    assert.deepEqual(set.map((id) => id), ["a"]);
    assert.ok(entry);
  }
});
`,
    "engine/src/bad.integration.test.ts": `import assert from "node:assert/strict";
import test from "node:test";
test("bare rows", async () => {
  const rows = (await db.execute(sql\`select id\`)).rows;
  for (const row of rows) assert.ok(row.id);
});
`,
  });
  try {
    assert.deepEqual(scanFile(join(root, "engine/src/ok.integration.test.ts"), root), []);
    const findings = scanFile(join(root, "engine/src/bad.integration.test.ts"), root);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].collection, "rows");
    assert.equal(scanTree(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live repository has no unanchored assertion-bearing loops", () => {
  const findings = scanTree();
  assert.deepEqual(findings, [], `${findings.length} unanchored loops:\n${findings.map((finding) => `${finding.file}:${finding.line} [${finding.name}] loop over \`${finding.collection}\``).join("\n")}`);
});

test("non-test files and loops without asserts are out of scope", () => {
  const root = fixtureTree({
    "engine/src/helper.ts": `export function each(rows) {
  for (const row of rows) console.log(row.id);
}
`,
  });
  try {
    assert.deepEqual(scanFile(join(root, "engine/src/helper.ts"), root), []);
    assert.deepEqual(scanTree(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
