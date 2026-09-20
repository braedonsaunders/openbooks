import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadMutationConfig, parseMutationConfig, resolveTargetTests } from "./config.ts";

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");

// The assignment's curated scope: every one of these areas must be covered.
const REQUIRED_COVERAGE = [
  "engine/src/money/money.ts",
  "engine/src/ledger/posting.ts",
  "engine/src/ledger/posting-effects.ts",
  "engine/src/sync/applications.ts",
  "engine/src/payments/payment-documents.ts",
  "engine/src/payments/payment-queries.ts",
  "engine/src/payments/settlement-policy.ts",
  "engine/src/payroll/run-calculation.ts",
  "engine/src/payroll/run-earning-lines.ts",
  "engine/src/tax/tax.ts",
  "engine/src/tax-returns/return.ts",
  "engine/src/consolidation/consolidation.ts",
  "engine/src/assets/depreciation.ts",
];

test("checked-in config covers the curated scope and every referenced file exists", () => {
  const config = loadMutationConfig();
  const paths = config.targets.map((t) => t.path);
  for (const required of REQUIRED_COVERAGE) {
    assert.ok(paths.includes(required), `config must cover ${required}`);
  }
  assert.ok(paths.some((p) => p.startsWith("engine/src/payroll/canada/")), "config must cover canada compute paths");
  assert.ok(paths.some((p) => p.startsWith("engine/src/payroll/us/")), "config must cover us compute paths");
  assert.equal(new Set(paths).size, paths.length, "no duplicate targets");
  for (const target of config.targets) {
    assert.ok(existsSync(join(REPO_ROOT, target.path)), `target exists: ${target.path}`);
    for (const testFile of target.tests) {
      assert.ok(existsSync(join(REPO_ROOT, testFile)), `mapped test exists: ${testFile}`);
    }
    if (target.lineRanges) {
      const lineCount = readFileSync(join(REPO_ROOT, target.path), "utf8").split("\n").length;
      for (const range of target.lineRanges) {
        assert.ok(range.end <= lineCount, `${target.path} range ends past EOF`);
      }
    }
  }
});

test("scoped targets carry line ranges (allocation math, stub assembly)", () => {
  const config = loadMutationConfig();
  const payments = config.targets.find((t) => t.path === "engine/src/payments/settlement-policy.ts");
  const payrollRun = config.targets.find((t) => t.path === "engine/src/payroll/run-earning-lines.ts");
  assert.ok(payments?.lineRanges && payments.lineRanges.length > 0, "settlement-policy.ts scoped to allocation/application math");
  assert.ok(payrollRun?.lineRanges && payrollRun.lineRanges.length > 0, "run-earning-lines.ts scoped to earning assembly + employer accruals");
});

test("parseMutationConfig rejects malformed configs", () => {
  assert.throws(() => parseMutationConfig("not json"), SyntaxError);
  assert.throws(() => parseMutationConfig(JSON.stringify({ version: 2, targets: [] })), /version/);
  assert.throws(
    () => parseMutationConfig(JSON.stringify({ version: 1, targets: [{ path: "a.ts", tests: [] }] })),
    /non-empty/,
  );
  assert.throws(
    () =>
      parseMutationConfig(
        JSON.stringify({
          version: 1,
          targets: [
            { path: "a.ts", tests: ["a.test.ts"] },
            { path: "a.ts", tests: ["a.test.ts"] },
          ],
        }),
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      parseMutationConfig(
        JSON.stringify({ version: 1, targets: [{ path: "a.ts", tests: ["a.test.ts"], lineRanges: [{ start: 0, end: 3 }] }] }),
      ),
    /lineRanges/,
  );
});

test("unmapped targets fall back to same-directory tests, never the harness itself", () => {
  const config = loadMutationConfig();
  const fallback = resolveTargetTests(config, "engine/src/sync/never-mapped.ts", REPO_ROOT);
  assert.ok(fallback.length > 0);
  assert.ok(fallback.every((f) => f.startsWith("engine/src/sync/")));
  assert.ok(!fallback.some((f) => f.includes("mutation-") || f.includes("harness-selfcheck")));
  // Curated entries win over the fallback.
  assert.deepEqual(resolveTargetTests(config, "engine/src/money/money.ts", REPO_ROOT), ["engine/src/money/money.test.ts"]);
});
