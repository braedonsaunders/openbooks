/** Expense amortization: the public engine contract for the application. */
export {
  AmortizationError,
  AMORTIZATION_FEATURE_KEY,
  AMORTIZATION_FEATURE_REMEDY,
} from "./errors.ts";
export {
  AMORTIZATION_METHODS,
  AMORTIZATION_TERM_SOURCES,
  MAX_AMORTIZATION_PERIODS,
  MAX_AMORTIZATION_PERIOD_OFFSET,
  type AmortizationMethod,
  type AmortizationTermSource,
} from "./plan.ts";
export {
  DEFERRAL_ACCOUNT_TYPES,
  DESTINATION_ACCOUNT_TYPES,
  listCurrentTemplates,
  validateTemplateWrite,
} from "./templates.ts";
export {
  AMORTIZATION_JOURNAL_ORIGIN,
  type ScheduleStatus,
  type ScheduleSourceKind,
} from "./schedule-store.ts";
export {
  activateSchedule,
  cancelSchedule,
  changeScheduleDestination,
  changeScheduleTerm,
  createManualSchedule,
  holdSchedule,
  reduceSchedule,
  resumeSchedule,
  type CancelMode,
  type CreateManualScheduleInput,
  type ScheduleChangeResult,
} from "./schedules.ts";
export {
  runExpenseAmortization,
  type AmortizationRunResult,
  type AmortizationRunProblem,
} from "./run.ts";
export {
  reconcileDeferralAccounts,
  dueUnpostedAmortization,
  type ReconciliationRow,
} from "./reconciliation.ts";
export { loadScheduleDetail, type ScheduleDetail } from "./read-model.ts";

export { amortizationLineRefusal, type AmortizationLineFields } from "./source-fields.ts";
export { validateSavedAmortizationLines } from "./source-posting.ts";
