/** Recurring per-employee pay-component assignments — the write side of the rows the pay run prices every regular period. */
export {
  employeePayComponentScopeLock,
  validateEmployeePayComponentAssignment,
  type EmployeePayComponentAssignmentInput,
  type ValidatedAssignment,
} from "./assigned-components.ts";
export { PayrollError } from "./error.ts";
