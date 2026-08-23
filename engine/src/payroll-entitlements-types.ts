/**
 * Engine bindings a plan may claim. `code` is tenant-editable free text and is
 * NEVER an engine binding (schema/src/payroll-entitlements.ts explains the
 * doctrine, which is pay_components.systemKey's); this is.
 */
export type EntitlementPlanSystemKey = "vacation";

/** The system key of the plan employee_payroll_profiles.vacation_* drives. */
export const VACATION_PLAN_SYSTEM_KEY: EntitlementPlanSystemKey = "vacation";

export type EntitlementUnit = "money" | "hours";
export type EntitlementDirection = "accrue" | "owe";
export type EntitlementAccrualMethod =
  | "percent_of_earnings"
  | "per_hour_worked"
  | "fixed_per_period"
  | "manual";
export type EntitlementCapBehavior = "warn" | "block" | "auto_payout";
export type EntitlementMovementKind =
  | "opening"
  | "accrual"
  | "bank_in"
  | "payout"
  | "repayment"
  | "adjustment";

/** Resolution order for a scoped limit row — most specific first. */
export type EntitlementLimitScope =
  | "employee"
  | "job_title"
  | "trade"
  | "department"
  | "subsidiary"
  | "plan";

export interface EntitlementPlan {
  id: string;
  /** Operator-typed. Display and reporting only — never an engine match key. */
  code: string;
  /** Engine binding; null for tenant-defined plans. */
  systemKey: EntitlementPlanSystemKey | null;
  name: string;
  unit: EntitlementUnit;
  direction: EntitlementDirection;
  accrualMethod: EntitlementAccrualMethod;
  accrualValue: string | null;
  accrualComponentId: string | null;
  payoutComponentId: string | null;
  liabilityAccountId: string | null;
  capBehavior: EntitlementCapBehavior;
}

export interface EntitlementPlanLimit {
  id: string;
  planId: string;
  maxBalance: string | null;
  notifyBalance: string | null;
  scope: EntitlementLimitScope;
  effectiveFrom: string;
}

/** The scope keys a limit row can be pinned to — the labor_cost_rates set. */
export interface EntitlementScopeKeys {
  employeePartyId: string | null;
  jobTitle: string | null;
  tradeId: string | null;
  departmentId: string | null;
  subsidiaryId: string | null;
}

/** A candidate limit row as stored: scope keys plus the effective window. */
export interface EntitlementLimitRow extends EntitlementScopeKeys {
  id: string;
  planId: string;
  maxBalance: string | null;
  notifyBalance: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}
