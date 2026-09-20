/**
 * Pay run pipeline: create → calculate → commit → (standard document post).
 *
 * A pay run is documents kind 'pay_run'. Stubs and their lines are the
 * payroll subledger; commit materializes the balanced GL projection into
 * document_lines (signed, like a journal), so posting, voiding, numbering,
 * and period control ride the standard machinery in engine/src/ledger/posting.ts.
 *
 * Wages resolve from labor_cost_rates (employee scope — the one-table
 * doctrine); statutory amounts come from the versioned T4127 engine. YTD
 * state = payroll_opening_balances + previously committed stubs, so
 * recalculating an uncommitted run is always safe.
 */
// Defined in its own cycle-free module so `extends PayrollError` is safe at
// module-evaluation time anywhere in payroll; re-exported here because this is
// where the rest of the codebase has always imported it from.
export { PayrollError } from "./error.ts";
export { employeeTaxYearFenceKey } from "./fences.ts";
export { type PayRunCalculationSourceSnapshot, payRunCalculationSourceDigest, parsePayRunCalculationSource, payRunCalculationSource, payRunCalculationSourceChanges, type PayRunCalculationError, type PayRunRefusalAcknowledgement, payRunCalculationRefusals, payRunRefusalDigest, parsePayRunCalculationErrors, parsePayRunRefusalAcknowledgement } from "./run-calculation-evidence.ts";
export { divideMoney, allocateProportionally } from "./run-allocation.ts";
export { type SemiMonthlyBoundaries, semiMonthlyAnchorProblem, payPeriodsPerYearProblem, semiMonthlyBoundaries, nextPeriodAfter } from "./run-calendar.ts";
export { PayrollSettings, payrollSettings, seedPayrollComponents, ensureStatutoryHolidayComponents, statutoryHolidayPayEnabled } from "./run-setup.ts";
export { PayRunType, payrollSubsidiaryInScope, payrollSubsidiaryScopeFilter, payrollSubsidiaryOutsideScopeFilter, type PayrollSubsidiaryScope, createPayRun, payScheduleSubsidiaryProblem, discardPayRun, rescopePayScheduleRuns } from "./run-lifecycle.ts";
export { CapturedStubLine, CapturedStub, PayRunCalculation, captureCalculatedStubs, CalculatePayRunInput, calculatePayRun } from "./run-calculation.ts";
export { ExpenseAccountSource, Line, statutoryHolidayLinesForStub } from "./run-stub-records.ts";
export { settleDeductionProtection } from "./run-protection.ts";
export { PayRunGlLeg, acknowledgePayRunRefusals, commitPayRun, previewPayRunGl } from "./run-commit.ts";
