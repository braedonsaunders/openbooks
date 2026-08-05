import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cli = readFileSync("engine/src/harness/replay/cli.ts", "utf8");
const exporter = readFileSync("engine/src/harness/replay/export.ts", "utf8");
const rebuild = readFileSync("engine/src/harness/replay/rebuild.ts", "utf8");

test("replay commands require an explicit dedicated simulation database", () => {
  assert.match(cli, /assertSimEnabled\(\)/);
  assert.match(cli, /assertDedicatedSimDatabase\("replay validation harness"\)/);
  assert.match(exporter, /await assertSimOrg\(world\.orgId\)/);
});

test("a diagnostic GL fallback can never produce a passing replay report", () => {
  const passAssignment = rebuild.match(/report\.pass\s*=[\s\S]*?return \{ report, world: corpusWorld \};/)?.[0] ?? "";
  assert.match(passAssignment, /report\.fallbacks\.length === 0/);
  assert.match(passAssignment, /report\.hardFailures\.length === 0/);
  assert.match(passAssignment, /integrity\.pass/);
});
