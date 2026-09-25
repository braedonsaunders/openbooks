/**
 * Revenue recognition (ASC 606 / IFRS 15), source platform ARM-shaped.
 *
 * An obligation carries an allocated amount to recognize over a term. A rule
 * (method + date sources + offsets + accounts) spreads that amount into a
 * per-book, per-period plan (recognition_schedules + one line per period). All
 * of it is org-configured data — see schema/src/revenue.ts.
 *
 * runRevenueRecognition(asOfDate) walks every schedule line whose period has
 * ended on or before the as-of date and is not yet posted, and posts one
 * balanced system journal per line straight through the kernel:
 *
 *     DR deferred revenue      (planned amount)
 *     CR recognized revenue    (planned amount)
 *
 * origin = 'revenue_recognition'; the entry is NOT a document. Idempotency: a
 * line is "posted" once its journal_entry_id is set, so re-running never
 * double-posts. The upstream invoice must have parked the money in deferred
 * revenue (posting.ts credits the item's deferred account for rev-rec lines),
 * so recognition simply drains deferred → earned over the term.
 *
 * A manual credit memo against the source invoice relieves deferred revenue
 * WITHOUT touching the plan — so the run caps every posting at what remains
 * genuinely unearned (allocated − recognized − credited-to-deferred). After a
 * full-remainder credit the run posts nothing; after a partial credit it posts
 * only the remainder (the final line may post partial). Credits that debit an
 * income account instead — a concession while service continues — never count:
 * they reduce earned directly and must not retire the plan.
 */

export { MAX_RECOGNITION_TERM_MONTHS } from "./recognition-limits.ts";
export { allocateByRelativeSSP, apportion, fairValueRangeFlag } from "./recognition-apportionment.ts";
export { addDays } from "./recognition-dates.ts";
export { recordRecognitionEvent } from "./recognition-events.ts";
export type { RecordRecognitionEventInput, RecordRecognitionEventResult } from "./recognition-events.ts";
export { createObligationsFromInvoice, revenueContractPostingEffectKey, revenueObligationPostingEffectKey } from "./recognition-obligations.ts";
export type { CreateObligationsResult } from "./recognition-obligations.ts";
export { recognitionUnearnedRemaining } from "./recognition-posting-rows.ts";
export type { FingerprintedRecognitionLine } from "./recognition-posting-rows.ts";
export { previewRevenueRecognition, recognitionPreviewFingerprint } from "./recognition-preview.ts";
export type { RecognitionPreview, RecognitionPreviewInput, RecognitionPreviewRow, RecognitionSkipReason } from "./recognition-preview.ts";
export { StaleRecognitionPreviewError, revenueRecognitionEntryNumber, runRevenueRecognition } from "./recognition-run.ts";
export type { RevenueRecognitionEntryIdentity, RunRecognitionResult } from "./recognition-run.ts";
export { buildAllRecognitionSchedules, buildAllRecognitionSchedulesInTransaction, buildRecognitionSchedule, buildRecognitionScheduleOn, legacyRebuildBlock, lockRevenueContract, obligationAttribution, recognitionProgressTarget, reconcileLegacyObligationProvenance, revenueContractAttribution } from "./recognition-schedule-build.ts";
export type { BuildRecognitionResult, LegacyRebuildBlock, ObligationAttribution, RevenueChangeBasis } from "./recognition-schedule-build.ts";
export { computeRecognitionSchedule } from "./recognition-schedule.ts";
export type { RecognitionInput, RecognitionLinePlan, RecognitionMethod } from "./recognition-schedule.ts";
export { MAX_FINANCING_DEFERRAL_YEARS, RevenueRecognitionError, TransactionPriceError, estimateVariableConsideration, recognitionBaseAmount, revenueRecognitionFeatureEnabled, separateFinancingComponent, setContractPricing } from "./recognition-transaction-price.ts";
export type { ContractPricingInput, ContractPricingResult, FinancingComponentInput, FinancingComponentResult, VariableConsiderationInput, VariableConsiderationResult, VariableEstimationMethod } from "./recognition-transaction-price.ts";
