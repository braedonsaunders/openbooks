/**
 * HR-2b URL contract for the HR departments board drill-through.
 *
 * The board (stacked separately) links each department row to the native
 * employee list with the department quick filter applied, and its
 * Unassigned row with the unassigned value. This module is the single
 * place that contract lives: the list owns the `department` parameter
 * (see the employee source in web/lib/list/entity-sources.ts and the
 * where builder in
 * web/lib/customization/entity-list-query/employment-directory.ts), and
 * the board builds its links through employeeDirectoryLinkForDepartment
 * instead of hand-writing query strings that would drift.
 *
 * Pure and dependency-free on purpose: no server-only, no database, no
 * framework — any component may import it. Contract:
 *   path   /entities/employees
 *   param  department
 *   values <department id> | unassigned
 */

export const EMPLOYEE_LIST_PATH = "/entities/employees" as const;

/** URL parameter the employee list's department quick filter reads. */
export const EMPLOYEE_LIST_DEPARTMENT_PARAM = "department" as const;

/** Department filter value listing employments with no department. */
export const EMPLOYEE_LIST_UNASSIGNED_DEPARTMENT = "unassigned" as const;

/**
 * Employee-list href filtered to one department, or to the unassigned
 * roster when departmentId is null. An empty id is refused — it is never
 * a department, and silently linking it would show the wrong roster.
 */
export function employeeDirectoryLinkForDepartment(departmentId: string | null): string {
  const value =
    departmentId === null ? EMPLOYEE_LIST_UNASSIGNED_DEPARTMENT : departmentId.trim();
  if (value.length === 0) {
    throw new Error(
      "employee directory link needs a department id or null for the unassigned roster — refusing an empty id rather than linking the wrong roster",
    );
  }
  return `${EMPLOYEE_LIST_PATH}?${EMPLOYEE_LIST_DEPARTMENT_PARAM}=${encodeURIComponent(value)}`;
}
