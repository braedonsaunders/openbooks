import { runDepreciation as engineRunDepreciation } from "../depreciation.ts";
import { runDueRecurringSchedules } from "../recurring.ts";
import { runDunning as engineRunDunning } from "../dunning.ts";
import { computeTaxReturn } from "../tax-return.ts";
import { runRevaluation } from "../fx-revaluation.ts";
import { runOwnershipConsolidation, runAutoElimination } from "../consolidation.ts";
import type { SimOrg } from "./world.ts";

/**
 * Phase 6 — the period-driven engines, exposed as thin typed wrappers the
 * controller (or autopilot) invokes at a period boundary. Each is idempotent and
 * a safe no-op when there is nothing to process, so wiring them exercises the
 * real engine entry point even before a profile seeds the underlying data
 * (assets, recurring schedules, dunning policies, tax forms, FX positions).
 */

/** Post all depreciation lines due on/before the date (DR expense / CR accum dep). */
export async function runDepreciationForDate(world: SimOrg, asOfDate: string, actorId: string) {
  return engineRunDepreciation(world.orgId, asOfDate, actorId);
}

/** Generate documents from any recurring schedules due on/before the date. */
export async function runRecurringForDate(asOf: string) {
  return runDueRecurringSchedules(asOf);
}

/** Emit dunning notices for overdue receivables as of the date (communications only). */
export async function runDunningForDate(asOf: string) {
  return engineRunDunning(asOf);
}

/** Compute a filing-period tax return (read-only; requires the form to be configured). */
export async function prepareTaxReturn(world: SimOrg, formCode: string, from: string, to: string) {
  return computeTaxReturn(world.orgId, formCode, from, to);
}

/** Run FX revaluation for a period (requires multi-currency positions + fxUnrealizedGainLoss). */
export async function runFxRevaluationForPeriod(world: SimOrg, periodId: string, actorId: string) {
  return runRevaluation(world.orgId, periodId, actorId);
}

/** Run intercompany elimination + ownership consolidation for a period. */
export async function runConsolidationForPeriod(world: SimOrg, periodId: string, actorId: string) {
  const elimination = await runAutoElimination(world.orgId, periodId, actorId);
  const ownership = await runOwnershipConsolidation(world.orgId, periodId, actorId);
  return { elimination, ownership };
}
