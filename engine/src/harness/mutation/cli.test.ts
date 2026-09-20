/**
 * Publisher merge ratchet for `--write-checked-in`.
 *
 * The publisher must never lower ratified evidence: a partial run preserves
 * unselected targets, a fresh entry that measured nothing never overwrites a
 * ratified measurement, and a fresh measured score below a ratified score
 * keeps the ratified entry while recording a refusal that names the remedy.
 * Only a full run drops entries for targets that left the config, and floors
 * are never written here — raises stay an explicit ratification act.
 *
 * Pure unit tests: no database, no mutation run, no filesystem.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeCheckedInReports,
  toCheckedInReport,
  type CheckedInReport,
  type CheckedInTarget,
} from "./cli.ts";
import type { MutationReport, TargetResult } from "./runner.ts";

const POSTING = "engine/src/ledger/posting.ts";
const PAYMENTS = "engine/src/payments/payments.ts";
const RUN = "engine/src/payroll/run.ts";
const MONEY = "engine/src/money/money.ts";
const COMMIT = "engine/src/ledger/posting-commit.ts";

// Ratified floor values from mutation-floor.json.
const POSTING_FLOOR = 0.34782608695652173;
const PAYMENTS_FLOOR = 0.041666666666666664;
const RUN_FLOOR = 0.32;

function target(
  path: string,
  over: Partial<CheckedInTarget> = {},
): CheckedInTarget {
  return {
    target: path,
    needsDb: false,
    status: "measured",
    killed: 8,
    survived: 15,
    timedOut: 0,
    skipped: 0,
    error: 2,
    total: 25,
    measured: 23,
    ratio: POSTING_FLOOR,
    topSurvivors: [],
    ...over,
  };
}

function report(paths: readonly string[], over: Partial<CheckedInReport> = {}): CheckedInReport {
  return {
    version: 1,
    gitSha: "ratified-sha",
    at: "2026-09-16T01:51:19.042Z",
    mode: "unit",
    targets: paths.map((p) => target(p)),
    ...over,
  };
}

function freshReport(paths: readonly string[], over: Partial<CheckedInReport> = {}): CheckedInReport {
  return {
    version: 1,
    gitSha: "fresh-sha",
    at: "2026-09-20T00:00:00.000Z",
    mode: "unit",
    targets: paths.map((p) => target(p)),
    ...over,
  };
}

test("partial publish preserves unselected ratified entries instead of clobbering them", () => {
  const existing = report([MONEY, POSTING], {
    targets: [
      target(MONEY, { ratio: 0.5217391304347826 }),
      target(POSTING, { ratio: POSTING_FLOOR }),
    ],
  });
  // Fresh run covered only money, scoring higher.
  const fresh = freshReport([MONEY], {
    targets: [target(MONEY, { ratio: 0.6, killed: 12, survived: 8, measured: 20 })],
  });
  const merged = mergeCheckedInReports(existing, fresh, [MONEY, POSTING]);

  assert.equal(merged.report.targets.length, 2);
  assert.deepEqual(
    merged.report.targets.find((t) => t.target === POSTING),
    existing.targets.find((t) => t.target === POSTING),
    "unselected posting entry must survive byte-identical",
  );
  assert.equal(merged.report.targets.find((t) => t.target === MONEY)?.ratio, 0.6);
  assert.equal(merged.refusals.length, 0);
  assert.ok(
    merged.preserved.some((line) => line.includes(POSTING)),
    "preservation must be reported",
  );
  // A partial refresh must not present itself as a fresh full measurement.
  assert.equal(merged.report.gitSha, "ratified-sha");
  assert.equal(merged.report.at, existing.at);
});

test("publish refuses to lower a ratified score and the refusal names the remedy", () => {
  const existing = report([PAYMENTS], {
    targets: [target(PAYMENTS, { ratio: 0.5, measured: 24 })],
  });
  const fresh = freshReport([PAYMENTS], {
    targets: [target(PAYMENTS, { ratio: PAYMENTS_FLOOR, measured: 24 })],
  });
  const merged = mergeCheckedInReports(existing, fresh, [PAYMENTS]);

  assert.equal(merged.report.targets[0]?.ratio, 0.5, "ratified entry must win");
  assert.equal(merged.refusals.length, 1);
  const refusal = merged.refusals[0]!;
  assert.ok(refusal.includes(PAYMENTS), "refusal names the target");
  assert.ok(
    refusal.includes(`--target ${PAYMENTS}`),
    "refusal names the re-run remedy",
  );
  assert.ok(
    refusal.includes("mutation-floor.json"),
    "refusal names the explicit ratification path",
  );
});

test("a fresh run that measured nothing never overwrites a ratified measurement", () => {
  const existing = report([RUN], {
    mode: "db",
    targets: [target(RUN, { ratio: RUN_FLOOR, measured: 25, needsDb: true })],
  });
  // Unit-mode re-run: the DB-only target self-skips its baseline.
  const fresh = freshReport([RUN], {
    mode: "unit",
    targets: [
      target(RUN, {
        status: "baseline-skipped",
        killed: 0,
        survived: 0,
        total: 0,
        measured: 0,
        ratio: null,
        needsDb: true,
      }),
    ],
  });
  const merged = mergeCheckedInReports(existing, fresh, [RUN]);

  assert.equal(merged.report.targets[0]?.ratio, RUN_FLOOR);
  assert.equal(merged.report.targets[0]?.measured, 25);
  assert.equal(merged.refusals.length, 0, "no measurement, no score refusal — preservation note suffices");
  assert.ok(merged.preserved.some((line) => line.includes(RUN)));
});

test("a fresh score above the ratified score replaces it without refusal", () => {
  const existing = report([MONEY], {
    targets: [target(MONEY, { ratio: 0.4, measured: 23 })],
  });
  const fresh = freshReport([MONEY], {
    targets: [target(MONEY, { ratio: 0.5217391304347826, measured: 23 })],
  });
  const merged = mergeCheckedInReports(existing, fresh, [MONEY]);

  assert.equal(merged.report.targets[0]?.ratio, 0.5217391304347826);
  assert.equal(merged.refusals.length, 0);
  assert.equal(merged.preserved.length, 0);
  // Full run adopts the fresh run's provenance.
  assert.equal(merged.report.gitSha, "fresh-sha");
});

test("only a full run drops stale entries for unconfigured targets", () => {
  const existing = report([POSTING, COMMIT], {
    targets: [target(POSTING, { ratio: POSTING_FLOOR }), target(COMMIT, { ratio: 0.4 })],
  });

  const partial = mergeCheckedInReports(
    existing,
    freshReport([COMMIT], { targets: [target(COMMIT, { ratio: 0.45 })] }),
    [COMMIT, MONEY],
  );
  assert.ok(
    partial.report.targets.some((t) => t.target === POSTING),
    "partial run must preserve the decomposed monolith entry",
  );
  assert.deepEqual(partial.dropped, []);

  // Full run: every configured target present, monolith gone from config.
  const full = mergeCheckedInReports(
    existing,
    freshReport([COMMIT], { targets: [target(COMMIT, { ratio: 0.45 })] }),
    [COMMIT],
  );
  assert.ok(full.report.targets.some((t) => t.target === POSTING) === false);
  assert.deepEqual(full.dropped, [POSTING]);
  assert.equal(full.report.targets.find((t) => t.target === COMMIT)?.ratio, 0.45);
});

test("first publish writes the fresh report as-is", () => {
  const fresh = freshReport([MONEY]);
  const merged = mergeCheckedInReports(null, fresh, [MONEY]);
  assert.deepEqual(merged.report, fresh);
  assert.deepEqual([...merged.preserved, ...merged.refusals, ...merged.dropped], []);
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
        target: RUN,
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
  assert.equal(compact.targets[1]?.ratio, null, "unmeasured stays null — never a manufactured zero");
  assert.equal(compact.targets[1]?.measured, 0);
});
