import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { filesWithoutTests } from "./verify-test-registration.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("registration receipt: pass greens, empty and load-dead red", () => {
  const fixtures = ["pass", "empty", "load-death"].map((name) => `scripts/test-registration.fixtures/${name}.fixture.mjs`);
  const dir = mkdtempSync(join(tmpdir(), "test-registration-"));
  const receipt = join(dir, "receipt.jsonl");
  // The runner's own plumbing leaks through spawn inheritance and makes a
  // nested `node --test` skip every file with exit zero — the very shape
  // under test. Scrub exactly those two variables for the inner run.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const args = ["--test", "--test-reporter", "./scripts/test-hooks.mjs", "--test-reporter-destination", receipt];
  spawnSync(process.execPath, [...args, ...fixtures.map((file) => resolve(ROOT, file))], { cwd: ROOT, encoding: "utf8", env });
  assert.deepEqual(filesWithoutTests(fixtures, readFileSync(receipt, "utf8")).sort(), [fixtures[1], fixtures[2]]);
  const solo = spawnSync(process.execPath, [...args, resolve(ROOT, fixtures[1])], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(solo.status, 0, "a file registering no tests still exits zero");
});
