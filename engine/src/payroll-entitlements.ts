/**
 * Entitlement plans — the pay-bank engine (banked overtime, vacation, benefit
 * recoup during leave) and the service-based schedules that drive them.
 *
 * Doctrine (see schema/src/payroll-entitlements.ts for the long form):
 *
 * - Balance = SUM(entitlement_ledger). There is no materialized balance and
 *   this module never writes one. Everything here either reads that sum or
 *   appends to the ledger.
 * - Balances are stored in the plan's `unit`, money by default, and DISPLAYED
 *   in hours at the employee's effective wage. Hours-denominated banks quietly
 *   revalue as wages rise; money ones do not.
 * - Limits resolve exactly like labor_cost_rates wages (employee > job title >
 *   trade > department > subsidiary > plan default, latest effective_from
 *   wins) — one scoping mechanism in this product, not two.
 * - All arithmetic goes through money.ts. No floats, ever.
 *
 * Shape: the decision kernels (`pickPlanLimit`, `monthsOfService`,
 * `pickServiceTier`, `computePlanMovement`) are PURE and unit-tested without a
 * database; the exported async functions are thin adapters that load rows and
 * call them. This is the same split labor-costing.ts uses for
 * `resolveWage` / `computeCostRate`.
 *
 * This file is the module's public surface: it re-exports the cohesive
 * sibling modules below without changing any name or signature.
 */

export {
  type EntitlementAccrualMethod,
  type EntitlementCapBehavior,
  type EntitlementDirection,
  type EntitlementLimitRow,
  type EntitlementLimitScope,
  type EntitlementMovementKind,
  type EntitlementPlan,
  type EntitlementPlanLimit,
  type EntitlementPlanSystemKey,
  type EntitlementScopeKeys,
  type EntitlementUnit,
  VACATION_PLAN_SYSTEM_KEY,
} from "./payroll-entitlements-types.ts";

export {
  limitScopeOf,
  pickPlanLimit,
} from "./payroll-entitlements-limits.ts";

export {
  monthsOfService,
  pickServiceTier,
  type ResolvedServiceTiers,
  resolveServiceTiersFrom,
  type ServiceTierRow,
} from "./payroll-entitlements-service-tiers.ts";

export {
  computePlanMovement,
  type EntitlementMovement,
  type EntitlementWarning,
  type PlanMovementInput,
  type PlanMovementResult,
} from "./payroll-entitlements-movement-kernel.ts";

export {
  entitlementBalances,
  entitlementPlans,
  type EntitlementBalance,
  planBalanceExcludingRun,
  resolvePlanLimit,
  resolveServiceTier,
  vacationPlanOf,
} from "./payroll-entitlements-db.ts";

export {
  planMovementsForStub,
  recordEntitlementMovements,
  type StubEarningLine,
  type StubMovementPlan,
} from "./payroll-entitlements-stub.ts";

export {
  assertMovementDate,
  type EntitlementOpeningLock,
  entitlementOpeningBlocks,
  entitlementOpeningLocks,
  entitlementOpenings,
  type EntitlementOpeningRow,
  type EntitlementOpeningsResult,
} from "./payroll-entitlements-openings.ts";

export {
  EntitlementOpeningSaveError,
  type EntitlementOpeningSaveResult,
  type EntitlementOpeningWrite,
  saveEntitlementOpenings,
} from "./payroll-entitlements-openings-save.ts";

export {
  employeesNearLimit,
  type NearLimitEmployee,
  milestonesReachedInPeriod,
  type ServiceMilestone,
} from "./payroll-entitlements-reports.ts";
