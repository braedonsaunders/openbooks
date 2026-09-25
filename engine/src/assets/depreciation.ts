/**
 * Fixed-asset depreciation.
 *
 * A schedule is a per-book plan of monthly depreciation amounts derived from an
 * asset (cost, salvage, in-service date, useful life, method). Building a
 * schedule stores the plan (depreciation_schedules + one line per calendar
 * month it can be posted into, mapped to an accounting_period).
 *
 * runDepreciation(asOfDate) walks every schedule line whose period has ended on
 * or before the as-of date and is not yet posted, and posts one balanced system
 * journal per line straight through the kernel:
 *
 *     DR depreciation expense        (planned amount)
 *     CR accumulated depreciation    (planned amount)
 *
 * origin = 'depreciation'; the entry is NOT a document. Idempotency: a line is
 * "posted" once its journal_entry_id is set, so re-running never double-posts —
 * the posted period is tracked on the line itself.
 */

export { DepreciationRefusalError, POSTABLE_DEPRECIATION_STATUSES, assertPostableDepreciationStatus } from "./depreciation-errors.ts";
export { recordDepreciationInput } from "./depreciation-inputs.ts";
export type { RecordDepreciationInputArgs, RecordDepreciationInputResult } from "./depreciation-inputs.ts";
export { previewDepreciation } from "./depreciation-preview.ts";
export type { DepreciationPreview, DepreciationPreviewInput, DepreciationPreviewRow } from "./depreciation-preview.ts";
export { ClosedBatchError, StalePreviewError, assertConfirmSetCurrent, previewDepreciationFingerprint, previewLineDrift, reconcileAssetDepreciationStatusWithRunner } from "./depreciation-run-scope.ts";
export type { ClaimedDepreciationLine, ExpectedDepreciationLine, FingerprintedDepreciationRow, NextDueDepreciation, RunDepreciationResult, RunDepreciationScope } from "./depreciation-run-scope.ts";
export { reloadClaimLine, runDepreciation } from "./depreciation-run.ts";
export { assetDepreciationCalendar, buildAllSchedules, buildAllSchedulesWithRunner, buildSchedule, buildScheduleWithRunner, unimpairedAssetCarryingValue } from "./depreciation-schedule-build.ts";
export type { BuildScheduleResult } from "./depreciation-schedule-build.ts";
export { compareMoney, computeSchedule, computeUnitsOfProductionCharge, resolveAssetAccounts } from "./depreciation-schedule-math.ts";
export type { AssetAccounts, DepreciationMethod, ScheduleInput, ScheduleLinePlan, UnitsOfProductionChargeInput } from "./depreciation-schedule-math.ts";
