import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkTree } from "./check-scratch-org-lease-shape.mjs";

const FIXTURES = 'export interface ScratchOrg { orgId: string }\nexport async function createScratchOrg(): Promise<ScratchOrg> { return { orgId: "one" } }\nexport const buildScratchOrg = async (): Promise<ScratchOrg> => ({ orgId: "two" })';

function tree(testSource) {
  const root = mkdtempSync(join(tmpdir(), "scratch-org-shape-"));
  for (const [name, content] of Object.entries({
    "engine/src/testing/fixtures.ts": FIXTURES,
    "engine/src/sample.integration.test.ts": testSource,
  })) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

test("finds aliased scratch-org factories in top-level before hooks", () => {
  const result = checkTree(tree('import test from "node:test"; import { before as setup } from "node:test"; import { createScratchOrg as makeOrg } from "./testing/fixtures.ts"; setup(async () => { await makeOrg() }); test("first", () => {}); test("second", () => {});'));
  assert.deepEqual(result.factories, ["buildScratchOrg", "createScratchOrg"]);
  assert.deepEqual(result.violations.map(({ topLevelTests }) => topLevelTests), [2]);
});

test("allows per-test leases across multiple top-level cases", () => {
  const result = checkTree(tree('import test, { beforeEach } from "node:test"; import * as fixtures from "./testing/fixtures.ts"; beforeEach(async () => { await fixtures.buildScratchOrg() }); test("first", () => {}); test("second", () => {});'));
  assert.deepEqual(result.violations, []);
});
