import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanFile, scanTree } from "./check-test-skips.mjs";

function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "openbooks-skips-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

test("infra-gated skips pass, bare and reason-string skips fail", () => {
  const root = fixtureTree({
    "engine/src/ok.integration.test.ts": `import test from "node:test";
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
test("reads", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {});
test("writes", enabled, async () => {});
test("platform", { skip: process.platform !== "linux" }, async () => {});
`,
    "engine/src/bad.test.ts": `import test from "node:test";
test("flaky", { skip: true }, () => {});
test("later", { skip: "waiting on backend" }, () => {});
`,
  });
  try {
    assert.deepEqual(scanFile(join(root, "engine/src/ok.integration.test.ts"), root), []);
    const findings = scanFile(join(root, "engine/src/bad.test.ts"), root);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings.map((finding) => finding.value).sort(), ['"waiting on backend"', "true"]);
    const tree = scanTree(root);
    assert.equal(tree.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fail-closed data shaped like { skip: ... } is not an option", () => {
  const root = fixtureTree({
    "engine/src/native.test.ts": `import assert from "node:assert/strict";
import test from "node:test";
test("unsupported posts fail closed", () => {
  assert.deepEqual(financial, {
    skip: "unsupported posting type ItemShip has ledger impact",
  });
});
`,
  });
  try {
    assert.deepEqual(scanFile(join(root, "engine/src/native.test.ts"), root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("method skips and unlisted t.skip fail, listed t.skip passes", () => {
  const root = fixtureTree({
    "engine/src/a.test.ts": `import test from "node:test";
test.skip("parked", () => {});
`,
    "engine/src/b.test.ts": `import test from "node:test";
test("probe", (t) => { t.skip("a brand new reason nobody recorded"); });
`,
  });
  try {
    const a = scanFile(join(root, "engine/src/a.test.ts"), root);
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "skip-method");
    const b = scanFile(join(root, "engine/src/b.test.ts"), root);
    assert.equal(b.length, 1);
    assert.equal(b[0].kind, "t.skip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live repository has no non-infra test skips", () => {
  const findings = scanTree();
  assert.deepEqual(findings, [], `${findings.length} skip violations:\n${findings.map((finding) => `${finding.file}:${finding.line} [${finding.kind}] ${finding.value}`).join("\n")}`);
});
