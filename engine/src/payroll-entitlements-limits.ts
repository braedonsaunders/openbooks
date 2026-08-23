import {
  type EntitlementLimitRow,
  type EntitlementLimitScope,
  type EntitlementPlanLimit,
  type EntitlementScopeKeys,
} from "./payroll-entitlements-types.ts";

const SCOPE_RANK: Record<EntitlementLimitScope, number> = {
  employee: 0,
  job_title: 1,
  trade: 2,
  department: 3,
  subsidiary: 4,
  plan: 5,
};

/** The scope a stored row occupies; null keys throughout = the plan default. */
export function limitScopeOf(row: EntitlementScopeKeys): EntitlementLimitScope {
  if (row.employeePartyId) return "employee";
  if (row.jobTitle) return "job_title";
  if (row.tradeId) return "trade";
  if (row.departmentId) return "department";
  if (row.subsidiaryId) return "subsidiary";
  return "plan";
}

/**
 * Most-specific-wins limit resolution, pure. Mirrors the precedence the wage
 * resolver applies (engine/src/labor-costing.ts `resolveWage`, and the
 * employee-scope shortcut `resolvePayRate` in payroll-run.ts): a row only
 * competes if its scope key matches the employee, and within the winning
 * scope the latest effectiveFrom ≤ onDate takes the row.
 */
export function pickPlanLimit(
  rows: readonly EntitlementLimitRow[],
  employee: EntitlementScopeKeys,
  onDate: string,
): EntitlementPlanLimit | null {
  let best: { row: EntitlementLimitRow; scope: EntitlementLimitScope } | null = null;
  for (const row of rows) {
    if (!row.isActive) continue;
    if (row.effectiveFrom > onDate) continue;
    if (row.effectiveTo && row.effectiveTo < onDate) continue;
    const scope = limitScopeOf(row);
    if (scope === "employee" && row.employeePartyId !== employee.employeePartyId) continue;
    if (scope === "job_title"
      && (employee.jobTitle ?? "").toLowerCase() !== (row.jobTitle ?? "").toLowerCase()) continue;
    if (scope === "trade" && row.tradeId !== employee.tradeId) continue;
    if (scope === "department" && row.departmentId !== employee.departmentId) continue;
    if (scope === "subsidiary" && row.subsidiaryId !== employee.subsidiaryId) continue;
    if (
      best === null
      || SCOPE_RANK[scope] < SCOPE_RANK[best.scope]
      || (SCOPE_RANK[scope] === SCOPE_RANK[best.scope] && row.effectiveFrom > best.row.effectiveFrom)
    ) {
      best = { row, scope };
    }
  }
  if (!best) return null;
  return {
    id: best.row.id,
    planId: best.row.planId,
    maxBalance: best.row.maxBalance,
    notifyBalance: best.row.notifyBalance,
    scope: best.scope,
    effectiveFrom: best.row.effectiveFrom,
  };
}
