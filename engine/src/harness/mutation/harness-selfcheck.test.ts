/**
 * Anti-false-green proof for the mutation harness.
 *
 * A harness that reports kills without ever executing a mutant is worse than
 * no harness. This test plants a deliberate mutant in a copy of the real
 * `money.ts` (arith `+` -> `-` in `add`), runs the REAL `money.test.ts`
 * against it in a temp dir, and asserts the suite fails there — while the
 * pristine copy passes in the same setup. If the temp execution environment
 * ever breaks, the pristine run fails first and this test goes red instead
 * of silently before-green.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateMutants } from "./operators.ts";

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");

function runMoneyTests(dir: string): { pass: number; fail: number; status: number | null } {
  const args = [
    ...(process.platform === "darwin" ? ["--no-concurrent-sparkplug", "--no-concurrent-recompilation"] : []),
    "--import", "tsx",
    "--test", "--test-force-exit", "--test-reporter=tap",
    "money.test.ts",
  ];
  // Scrub the outer test-runner context: without this, node:test detects a
  // recursive run() and refuses to execute files in the child. The temp run
  // is intentionally an independent execution, not a subtest.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    FORCE_COLOR: "0",
    OPENBOOKS_DB_URL: "",
    OPENBOOKS_DATA_KEY:
      process.env.OPENBOOKS_DATA_KEY ??
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    OPENBOOKS_TRUSTED_TEST_BYPASS: "1",
  };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const run = spawnSync(process.execPath, args, {
    cwd: dir,
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const pick = (label: string): number => {
    const m = output.match(new RegExp(`^# ${label} (\\d+)`, "m"));
    return m ? Number(m[1]) : 0;
  };
  return { pass: pick("pass"), fail: pick("fail"), status: run.status };
}

test("a deliberately planted money.ts mutant is reported as killed", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbooks-mutation-selfcheck-"));
  try {
    const nodeModules = join(REPO_ROOT, "node_modules");
    if (existsSync(nodeModules)) symlinkSync(nodeModules, join(dir, "node_modules"));
    const pristine = readFileSync(join(REPO_ROOT, "engine", "src", "money", "money.ts"), "utf8");
    const suite = readFileSync(join(REPO_ROOT, "engine", "src", "money", "money.test.ts"), "utf8");

    // The pristine copy must pass in this setup, or a kill below proves nothing.
    writeFileSync(join(dir, "money.ts"), pristine);
    writeFileSync(join(dir, "money.test.ts"), suite);
    const baseline = runMoneyTests(dir);
    assert.ok(baseline.pass > 0, `pristine money.test.ts must pass in temp (status ${baseline.status})`);
    assert.equal(baseline.fail, 0);

    // The planted mutant: the exact default-pipeline operator output the
    // runner would emit (inverts formatMoney's zero-precision branch). The
    // anchor is semantic, not a line number, so it survives source shifts;
    // if formatMoney ever loses this branch the lookup fails loudly below.
    const planted = generateMutants("engine/src/money/money.ts", pristine).find(
      (m) =>
        m.operator === "comparison-flip" &&
        m.mutatedSource.includes("decimalPlaces !== 0 ? whole!"),
    );
    assert.ok(planted, "operator set must produce the formatMoney guard-flip mutant in money.ts");
    writeFileSync(join(dir, "money.ts"), planted.mutatedSource);
    const mutated = runMoneyTests(dir);
    assert.ok(
      mutated.fail > 0,
      `planted mutant must be killed (pass=${mutated.pass} fail=${mutated.fail} status=${mutated.status})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
