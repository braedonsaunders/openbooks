import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTarget } from "./runner.ts";
import { toCheckedInReport } from "./cli.ts";

test("a database-owned target cannot acquire a unit score from neighboring tests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbooks-mutation-db-requirement-"));
  try {
    writeFileSync(join(dir, "transaction.ts"), "export const maxAttempts = 3;\n");
    const reason = "The selected operation reads locked source rows and atomically writes journal entries";
    const target = { path: "transaction.ts", tests: ["must-not-execute.test.ts"], needsDb: true, needsDbReason: reason };
    const result = await runTarget(dir, target, { repoRoot: dir, targets: [target], sample: 25, timeoutSecs: 1, useDb: false });
    assert.equal(result.status, "baseline-skipped");
    assert.equal(result.measured, 0);
    assert.equal(result.ratio, null);
    assert.deepEqual(result.baselineFiles, []);
    assert.deepEqual(result.mutants, []);
    assert.equal(result.unmeasuredReason, reason);
    const published = toCheckedInReport({ version: 1, gitSha: null, runId: null, casesSha256: "", dirtyTargets: [], at: "2026-09-20", mode: "unit", sample: 25, timeoutSecs: 1, targets: [result] });
    assert.equal(published.targets[0]?.unmeasuredReason, reason);
    assert.equal(published.targets[0]?.ratio, null);
    await assert.rejects(runTarget(dir, { ...target, needsDbReason: "" }, { repoRoot: dir, targets: [target], sample: 25, timeoutSecs: 1, useDb: false }), /database requirement has no source rationale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
