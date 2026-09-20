/**
 * Atomic publish gate for `--write-checked-in`.
 *
 * The publish covers exactly all configured targets or nothing is written:
 * partial runs, unconfigured extras, baseline-failed, no-mutants, unmeasured
 * non-DB entries, and measured scores below the RATIFIED floor all refuse
 * before any checked-in write. An honestly skipped `needsDb` target in a
 * unit-mode run stays allowed under existing policy. New targets without a
 * floor entry publish on their real measurement — the gate never invents
 * floors and never writes `mutation-floor.json`.
 *
 * Pure unit tests: no database, no mutation run, no filesystem.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkedInPublishRefusals,
  toCheckedInReport,
  type CheckedInReport,
  type CheckedInTarget,
  type RatifiedFloors,
} from "./cli.ts";
import type { MutationReport, TargetResult } from "./runner.ts";
import type { MutationTargetConfig } from "./config.ts";

const MONEY = "engine/src/money/money.ts";
const COMMIT = "engine/src/ledger/posting-commit.ts";
const RUN_CALC = "engine/src/payroll/run-calculation.ts";

function target(path: string, over: Partial<CheckedInTarget> = {}): CheckedInTarget {
  return {
    target: path,
    needsDb: false,
    status: "measured",
    killed: 12,
    survived: 11,
    timedOut: 0,
    skipped: 0,
    error: 2,
    total: 25,
    measured: 23,
    ratio: 12 / 23,
    topSurvivors: [],
    ...over,
  };
}

function configured(path: string, needsDb = false): MutationTargetConfig {
  return { path, tests: [`${path}.test`], ...(needsDb ? { needsDb: true as const } : {}) };
}

function fresh(paths: readonly string[], over: Partial<CheckedInReport> = {}): CheckedInReport {
  return {
    version: 1,
    gitSha: "fresh-sha",
    at: "2026-09-20T00:00:00.000Z",
    mode: "unit",
    targets: paths.map((p) => target(p)),
    ...over,
  };
}

const FLOORS: RatifiedFloors["floors"] = {
  [MONEY]: { ratio: 0.391304347826087, measured: 23, mode: "unit" },
};

test("full valid run publishes: measured above floors, new targets need no floor", () => {
  const report = fresh([MONEY, COMMIT], {
    targets: [
      target(MONEY, { ratio: 0.5217391304347826 }),
      target(COMMIT, { ratio: 0.4 }),
    ],
  });
  const refusals = checkedInPublishRefusals(
    report,
    [configured(MONEY), configured(COMMIT)],
    FLOORS,
  );
  assert.deepEqual(refusals, []);
});

test("partial run refuses: missing configured targets, nothing carried forward", () => {
  const refusals = checkedInPublishRefusals(
    fresh([MONEY]),
    [configured(MONEY), configured(COMMIT)],
    FLOORS,
  );
  assert.equal(refusals.length, 1);
  assert.ok(refusals[0]!.includes(COMMIT), "refusal names the missing target");
  assert.ok(refusals[0]!.includes("--target"), "refusal names the re-run remedy");
});

test("unconfigured extra in the run refuses", () => {
  const refusals = checkedInPublishRefusals(
    fresh([MONEY, COMMIT]),
    [configured(MONEY)],
    FLOORS,
  );
  assert.equal(refusals.length, 1);
  assert.ok(refusals[0]!.includes(COMMIT));
  assert.ok(refusals[0]!.includes("mutation.config.json"));
});

test("baseline-failed and no-mutants refuse", () => {
  const report = fresh([MONEY, COMMIT], {
    targets: [
      target(MONEY, { status: "baseline-failed", measured: 0, ratio: null }),
      target(COMMIT, { status: "no-mutants", measured: 0, ratio: null }),
    ],
  });
  const refusals = checkedInPublishRefusals(
    report,
    [configured(MONEY), configured(COMMIT)],
    FLOORS,
  );
  assert.equal(refusals.length, 2);
  assert.ok(refusals.some((r) => r.includes(MONEY) && r.includes("baseline failed")));
  assert.ok(refusals.some((r) => r.includes(COMMIT) && r.includes("zero mutants")));
});

test("unmeasured non-DB entry refuses; honest needsDb skip in unit mode is allowed", () => {
  const skipped: CheckedInTarget = {
    ...target(RUN_CALC),
    status: "baseline-skipped",
    killed: 0,
    survived: 0,
    total: 0,
    measured: 0,
    ratio: null,
    needsDb: true,
  };
  // needsDb target skipped in unit mode: allowed.
  const allowed = checkedInPublishRefusals(
    fresh([RUN_CALC], { mode: "unit", targets: [skipped] }),
    [configured(RUN_CALC, true)],
    {},
  );
  assert.deepEqual(allowed, []);

  // Same skip with a database available: refused, the run should have measured it.
  const refusedDb = checkedInPublishRefusals(
    fresh([RUN_CALC], { mode: "db", targets: [skipped] }),
    [configured(RUN_CALC, true)],
    {},
  );
  assert.equal(refusedDb.length, 1);

  // Non-DB target measuring nothing: refused.
  const refusedUnit = checkedInPublishRefusals(
    fresh([MONEY], { targets: [target(MONEY, { status: "baseline-skipped", measured: 0, ratio: null })] }),
    [configured(MONEY)],
    FLOORS,
  );
  assert.equal(refusedUnit.length, 1);
  assert.ok(refusedUnit[0]!.includes(MONEY));
});

test("measured score below the RATIFIED floor refuses and names the remedy", () => {
  const report = fresh([MONEY], {
    targets: [target(MONEY, { ratio: 0.34 })],
  });
  const refusals = checkedInPublishRefusals(report, [configured(MONEY)], FLOORS);
  assert.equal(refusals.length, 1);
  const refusal = refusals[0]!;
  assert.ok(refusal.includes(MONEY), "refusal names the target");
  assert.ok(refusal.includes("ratified floor"), "refusal cites the floor, not a prior score");
  assert.ok(refusal.includes(`--target ${MONEY}`), "refusal names the re-run remedy");
  assert.ok(refusal.includes("mutation-floor.json is raise-only"), "refusal cannot suggest lowering a floor");
});

test("score at the floor (within tolerance) publishes; dip below refuses", () => {
  const atFloor = fresh([MONEY], {
    targets: [target(MONEY, { ratio: 0.391304347826087 })],
  });
  assert.deepEqual(checkedInPublishRefusals(atFloor, [configured(MONEY)], FLOORS), []);
  const below = fresh([MONEY], {
    targets: [target(MONEY, { ratio: 0.39 })],
  });
  assert.equal(checkedInPublishRefusals(below, [configured(MONEY)], FLOORS).length, 1);
});

test("toCheckedInReport compacts without inventing ratios", () => {
  const mutation: MutationReport = {
    version: 1,
    gitSha: "abc",
    runId: null,
    casesSha256: "cases",
    dirtyTargets: [],
    at: "2026-09-20T00:00:00.000Z",
    mode: "unit",
    sample: 25,
    timeoutSecs: 240,
    targets: [
      {
        target: MONEY,
        status: "measured",
        needsDb: false,
        killed: 12,
        survived: 11,
        timedOut: 0,
        skipped: 0,
        error: 2,
        total: 25,
        measured: 23,
        ratio: 0.5217391304347826,
        baselineFiles: [],
        mutants: [],
      } satisfies TargetResult,
      {
        target: RUN_CALC,
        status: "baseline-skipped",
        needsDb: true,
        killed: 0,
        survived: 0,
        timedOut: 0,
        skipped: 0,
        error: 0,
        total: 0,
        measured: 0,
        ratio: null,
        baselineFiles: [],
        mutants: [],
      } satisfies TargetResult,
    ],
  };
  const compact = toCheckedInReport(mutation);
  assert.equal(compact.targets.length, 2);
  assert.equal(compact.targets[0]?.ratio, 0.5217391304347826);
  assert.equal(compact.targets[1]?.ratio, null, "unit-run skip stays null — never a manufactured zero");
  assert.equal(compact.targets[1]?.measured, 0);
});


test("invalid measured ratios cannot evade the floor", () => {
  for (const ratio of [NaN, Infinity, -0.1, 1.1]) {
    const refusals = checkedInPublishRefusals(
      fresh([MONEY], { targets: [target(MONEY, { ratio })] }),
      [configured(MONEY)], FLOORS,
    );
    assert.equal(refusals.length, 1);
    assert.ok(refusals[0]!.includes("invalid ratio"));
  }
});
