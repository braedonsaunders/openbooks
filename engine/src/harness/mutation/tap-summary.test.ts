import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseTap } from "./runner.ts";

test("mixed and all-skipped Node TAP summaries retain actual skip counts", () => {
  for (const allSkipped of [false, true]) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const run = spawnSync(process.execPath, ["--input-type=module", "--test-reporter=tap", "-e",
      `import test from 'node:test'; test('one', {skip: ${allSkipped}}, () => {}); test('two', {skip:true}, () => {});`,
    ], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    const actual = parseTap(run.stdout, run.status);
    assert.deepEqual(actual, { tests: 2, pass: allSkipped ? 0 : 1, fail: 0, skipped: allSkipped ? 2 : 1, crashed: false });
  }
});
