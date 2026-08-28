import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyBudgetVariance, classifyPeriodPerformance, classifyUnmatchedBankActivity, nextContinuousCloseRunAt } from "./continuous-close.ts";
import {
  defaultContinuousCloseDetectors,
  effectiveDetectorMateriality,
  enabledDetectorKeys,
  normalizeContinuousCloseAnalysisSettings,
  normalizeContinuousCloseDetectors,
} from "./continuous-close-config.ts";

const source = readFileSync(new URL("./continuous-close.ts", import.meta.url), "utf8");

test("unmatched bank activity escalates for age, count, or exact materiality", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  assert.equal(
    classifyUnmatchedBankActivity({
      materiality: "4999.9999",
      threshold: "1000.0000",
      oldestDate: "2026-07-15",
      count: 1,
      now,
    }),
    "warning",
  );
  assert.equal(
    classifyUnmatchedBankActivity({
      materiality: "5000.0000",
      threshold: "1000.0000",
      oldestDate: "2026-07-15",
      count: 1,
      now,
    }),
    "critical",
  );
  assert.equal(
    classifyUnmatchedBankActivity({
      materiality: "0.0000",
      threshold: "1000.0000",
      oldestDate: "2026-06-16",
      count: 1,
      now,
    }),
    "critical",
  );
  assert.equal(
    classifyUnmatchedBankActivity({
      materiality: "0.0000",
      threshold: "1000.0000",
      oldestDate: "2026-07-16",
      count: 50,
      now,
    }),
    "critical",
  );
});

test("unmatched-bank age uses the org business day, not UTC today", () => {
  assert.match(
    source,
    /const today = await businessToday\(orgId\);[\s\S]*?classifyUnmatchedBankActivity\(\{[\s\S]*?now: parseIsoDate\(today\)/,
  );
});

test("budget variance respects account signs, ten-percent floor, and exact money", () => {
  const incomeMiss = classifyBudgetVariance({
    budget: "1000.0000",
    actual: "899.9999",
    accountType: "income",
    threshold: "100.0000",
  });
  assert.deepEqual(incomeMiss, {
    include: true,
    favorable: false,
    variance: "-100.0001",
    varianceBps: 1000,
    severity: "warning",
  });

  const incomeBeat = classifyBudgetVariance({
    budget: "1000.0000",
    actual: "1300.0000",
    accountType: "income",
    threshold: "100.0000",
  });
  assert.equal(incomeBeat.favorable, true);
  assert.equal(incomeBeat.include, false);

  const expenseOverrun = classifyBudgetVariance({
    budget: "1000.0000",
    actual: "1250.0000",
    accountType: "expense",
    threshold: "100.0000",
  });
  assert.equal(expenseOverrun.favorable, false);
  assert.equal(expenseOverrun.include, true);
  assert.equal(expenseOverrun.varianceBps, 2500);
  assert.equal(expenseOverrun.severity, "critical");

  const belowMateriality = classifyBudgetVariance({
    budget: "1000.0000",
    actual: "1100.0000",
    accountType: "expense",
    threshold: "100.0001",
  });
  assert.equal(belowMateriality.include, false);
});

test("period performance detects exact revenue and gross-margin deterioration", () => {
  const result = classifyPeriodPerformance({
    currentRevenue: "800.0000",
    priorRevenue: "1000.0000",
    currentCogs: "450.0000",
    priorCogs: "400.0000",
    threshold: "200.0000",
  });
  assert.deepEqual(result, {
    revenueDecline: true,
    revenueChangeBps: -2000,
    grossMarginDropBps: 1625,
  });

  assert.equal(
    classifyPeriodPerformance({
      currentRevenue: "900.0000",
      priorRevenue: "1000.0000",
      currentCogs: "400.0000",
      priorCogs: "400.0000",
      threshold: "100.0001",
    }).revenueDecline,
    false,
  );
});

test("agent schedules advance in UTC without local-time drift", () => {
  const from = new Date("2026-03-08T06:30:00.000Z");
  assert.equal(nextContinuousCloseRunAt("daily", from).toISOString(), "2026-03-09T06:30:00.000Z");
  assert.equal(nextContinuousCloseRunAt("weekly", from).toISOString(), "2026-03-15T06:30:00.000Z");
});

test("the occurrence claim shares one transaction with the run row, closing the crash-skip window", () => {
  // The defect: the scheduler claimed by committing next_run_at advancement in
  // its own statement BEFORE calling runContinuousCloseAgent — a process killed
  // between the claim and the run's later insert stranded an advanced cursor
  // with no run record, permanently skipping the occurrence. The fix claims
  // INSIDE the agent's transaction, matching the recurring and subscription
  // schedulers, so either both commit or neither does.
  const source = readFileSync(new URL("./continuous-close.ts", import.meta.url), "utf8");
  const run = source.indexOf("export async function runContinuousCloseAgent");
  const orgTxn = source.indexOf("await withOrg(args.orgId, async (): Promise<PreparedRun>", run);
  const claim = source.indexOf("set next_run_at = ${occurrence.nextRunAt}", run);
  const runInsert = source.indexOf(".insert(schema.aiAgentRuns)", run);
  assert.notEqual(run, -1, "runContinuousCloseAgent exists");
  assert.ok(orgTxn > run, "the scan runs in one pinned org transaction");
  assert.ok(claim > orgTxn, "the occurrence is claimed inside that same transaction");
  assert.ok(runInsert > claim, "the durable run row follows the claim within it");
  const claimSql = source.slice(claim, source.indexOf("returning id", claim));
  assert.match(
    claimSql,
    /where id = \$\{occurrence\.policyId\} and org_id = \$\{args\.orgId\}\s+and next_run_at = \$\{occurrence\.claimedNextRunAt\}/,
    "the claim stays compare-and-swap and org-scoped: one tick wins an occurrence",
  );
  // The claimed fire time rides on every durable outcome, so the run record
  // keeps the occurrence's scheduled-for timestamp after a crash-gap resume.
  assert.match(source.slice(claim, source.indexOf("export async function runDueContinuousCloseAgents")), /scheduled_for: scheduledFor/);
});

test("nothing may claim an occurrence outside the agent transaction anymore", () => {
  // Any next_run_at writer left in the scheduler loop would reintroduce the
  // committed-claim crash window between scan and execution.
  const source = readFileSync(new URL("./continuous-close.ts", import.meta.url), "utf8");
  const due = source.indexOf("export async function runDueContinuousCloseAgents");
  const loop = source.slice(due);
  assert.doesNotMatch(loop, /set next_run_at/, "the loop never writes the cursor itself");
  assert.match(loop, /scheduledOccurrence:/, "the loop hands its observed occurrence to the agent");
});

test("detector policies default every registered control on and preserve explicit disablement", () => {
  const defaults = defaultContinuousCloseDetectors("accounting");
  assert.deepEqual(
    defaults.map((detector) => detector.detectorKey),
    ["unmatched_bank_activity", "reconciliation_difference", "stale_accounting_documents"],
  );
  assert.deepEqual(
    enabledDetectorKeys(defaults),
    defaults.map((detector) => detector.detectorKey),
  );

  const configured = normalizeContinuousCloseDetectors("accounting", {
    unmatched_bank_activity: {
      enabled: false,
      materialityThreshold: "2500.125",
      parameters: {
        criticalAgeDays: 14,
        criticalItemCount: 25,
        criticalMaterialityMultiple: 3,
      },
    },
  });
  assert.deepEqual(enabledDetectorKeys(configured), ["reconciliation_difference", "stale_accounting_documents"]);
  assert.equal(configured[0]!.materialityThreshold, "2500.1250");
  assert.equal(effectiveDetectorMateriality(configured[0]!, "1000.0000"), "2500.1250");
  assert.equal(effectiveDetectorMateriality(configured[1]!, "1000.0000"), "1000.0000");
});

test("detector policy validation rejects unsafe ranges and inverted severity thresholds", () => {
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("accounting", {
        stale_accounting_documents: { parameters: { staleAfterDays: 0 } },
      }),
    /invalid detector parameter/,
  );
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("finance", {
        unfavorable_budget_variance: {
          parameters: {
            minimumVariancePercent: 30,
            criticalVariancePercent: 20,
          },
        },
      }),
    /invalid detector parameter order/,
  );
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("finance", {
        period_revenue_decline: { materialityThreshold: "-0.0001" },
      }),
    /invalid materiality threshold/,
  );
});

test("agentic analysis defaults on and validates the bounded tool loop", () => {
  assert.deepEqual(normalizeContinuousCloseAnalysisSettings(null), {
    rootCauseAnalysis: true,
    recommendations: true,
    narrative: true,
    modelTier: "smart",
    maxToolSteps: 16,
  });
  assert.deepEqual(
    normalizeContinuousCloseAnalysisSettings({
      rootCauseAnalysis: false,
      recommendations: true,
      narrative: false,
      modelTier: "fast",
      maxToolSteps: 8,
    }),
    {
      rootCauseAnalysis: false,
      recommendations: true,
      narrative: false,
      modelTier: "fast",
      maxToolSteps: 8,
    },
  );
  assert.throws(
    () => normalizeContinuousCloseAnalysisSettings({ maxToolSteps: 31 }),
    /invalid agent tool step limit/,
  );
});

test("custom detector thresholds change inclusion and severity at exact boundaries", () => {
  assert.equal(
    classifyUnmatchedBankActivity({
      materiality: "2999.9999",
      threshold: "1000.0000",
      oldestDate: "2026-07-03",
      count: 24,
      now: new Date("2026-07-16T12:00:00Z"),
      criticalAgeDays: 14,
      criticalItemCount: 25,
      criticalMaterialityMultiple: 3,
    }),
    "warning",
  );
  assert.equal(
    classifyUnmatchedBankActivity({
      materiality: "3000.0000",
      threshold: "1000.0000",
      oldestDate: "2026-07-03",
      count: 24,
      now: new Date("2026-07-16T12:00:00Z"),
      criticalAgeDays: 14,
      criticalItemCount: 25,
      criticalMaterialityMultiple: 3,
    }),
    "critical",
  );

  const variance = classifyBudgetVariance({
    budget: "1000.0000",
    actual: "1200.0000",
    accountType: "expense",
    threshold: "100.0000",
    minimumVarianceBps: 1500,
    criticalVarianceBps: 2000,
  });
  assert.equal(variance.include, true);
  assert.equal(variance.severity, "critical");
});

test("reconciliation detector uses the same cutoff, currency, and transaction amount as sign-off", () => {
  const reconciliationStart = source.indexOf('const reconciliationPolicy = byKey.get("reconciliation_difference")');
  const staleStart = source.indexOf('const stalePolicy = byKey.get("stale_accounting_documents")', reconciliationStart);
  assert.notEqual(reconciliationStart, -1, "reconciliation detector exists");
  assert.notEqual(staleStart, -1, "reconciliation detector has a bounded query section");
  const reconciliationSource = source.slice(reconciliationStart, staleStart);

  assert.match(reconciliationSource, /select coalesce\(sum\(jl\.txn_amount\), 0\)/);
  assert.match(reconciliationSource, /join journal_entries je on[\s\S]*je\.status in \('posted', 'reversed'\)/);
  assert.match(reconciliationSource, /where jl\.org_id = \$\{orgId\} and jl\.account_id = r\.account_id/);
  assert.match(reconciliationSource, /and jl\.currency = r\.currency/);
  assert.match(reconciliationSource, /and je\.posting_date <= r\.through_date/);
  assert.match(reconciliationSource, /jl\.id in \(select journal_line_id from reconciliation_matches rm/);
  assert.match(reconciliationSource, /and org_id = \$\{orgId\}\)\)/);
  assert.doesNotMatch(reconciliationSource, /sum\(jl\.amount\)/);
});
