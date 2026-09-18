import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ALLOW, scanFile, scanTree } from "./check-test-teardown-swallow.mjs";

function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "openbooks-teardown-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

test("swallowed teardown drops fail, loud drops pass", () => {
  const root = fixtureTree({
    "web/lib/bad.integration.test.ts": `import test from "node:test";
test("direct", async () => { await dropScratchOrg(org.orgId).catch(() => {}); });
test("wrapped", async () => { await withBypassContext(() => dropScratchOrg(org.orgId)).catch(() => {}) });
test("reporting", async () => { await dropScratchOrgReporting(org.orgId).catch(() => undefined); });
test("continued", async () => { await dropScratchOrg(org.orgId)
  .catch(() => {}); });
`,
    "web/lib/ok.integration.test.ts": `import test from "node:test";
test("plain", async () => { await dropScratchOrg(org.orgId); });
test("wrapped", async () => { await withBypassContext(() => dropScratchOrg(org.orgId)); });
test("neighbor cleanup", async () => { try { await work(); } finally { await writer.query('rollback').catch(()=>{}); await pending?.catch(()=>{}); await writer.end(); await dropScratchOrg(org.orgId); } });
// await dropScratchOrg(org.orgId).catch(() => {})
test("message", async () => { assert.match(error, /dropScratchOrg.*\\.catch/); });
`,
  });
  try {
    assert.deepEqual(scanFile(join(root, "web/lib/ok.integration.test.ts"), root), []);
    const findings = scanFile(join(root, "web/lib/bad.integration.test.ts"), root);
    assert.equal(findings.length, 4);
    assert.ok(findings.every((finding) => finding.kind === "teardown-swallow"));
    assert.deepEqual(findings.map((finding) => finding.line), [2, 3, 4, 6]);
    const tree = scanTree(root);
    assert.equal(tree.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allow-list entries carry an explicit reason", () => {
  for (const entry of ALLOW) {
    assert.equal(typeof entry.file, "string");
    assert.ok(entry.file.length > 0);
    assert.equal(typeof entry.reason, "string");
    assert.ok(entry.reason.length > 0, `${entry.file} needs a reason`);
  }
});

test("the live repository has no swallowed teardown drops", () => {
  const findings = scanTree();
  assert.deepEqual(findings, [], `${findings.length} teardown-swallow violations:\n${findings.map((finding) => `${finding.file}:${finding.line} [${finding.kind}] ${finding.value}`).join("\n")}`);
});
