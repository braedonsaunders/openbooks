/** Payroll remittance execution. See the sibling remittance-* modules. */

export {
  remittanceGroupRegionalCalendar,
  remittanceRegionalCalendarsFor,
  groupRemittanceRows,
  scheduledRemittanceFrequency,
  scheduledRemittanceDueDateExplained,
  scheduleForRemittanceGroup,
  remittanceGroupDueDate,
} from "./remittance-group-schedule.ts";
export type {
  RemittanceComponentLine,
  RemittanceEntitySlice,
  RemittanceGroup,
  RemittanceGroupSchedule,
  RemittanceRow,
  RemittanceDue,
} from "./remittance-group-schedule.ts";
export { payrollRemittanceSummary, scheduledFrequencyAdvisory } from "./remittance-summary.ts";
export {
  makeRemittanceDestinationResolver,
  remittancePeriodProblem,
} from "./remittance-destination.ts";
export type { RemittanceResolvableRow } from "./remittance-destination.ts";
export {
  assertPayrollRemittanceBillCurrent,
  RemittanceSourceIntegrityError,
  assertRemittanceBillEdit,
} from "./remittance-bill-integrity.ts";
export {
  remittanceBillLockKey,
  remittanceFenceLockKey,
  duplicateRemittanceMessage,
  overlappingRemittanceMessage,
  pickRemittanceSequence,
  pickRemittanceSlice,
  createRemittanceBill,
} from "./remittance-bill-creation.ts";
export type { RemittanceBillKey } from "./remittance-bill-creation.ts";
export {
  remittanceScopeLines,
  coveredRemittanceStubLines,
  remittanceBillsWithoutCoverage,
} from "./remittance-coverage.ts";
export type { RemittanceScopeLine } from "./remittance-coverage.ts";
