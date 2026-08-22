import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { businessToday } from "./business-date.ts";
import {
  add, cmp, div, isZero, mulDecimal, mulPercent, neg, normalizeMoney, roundMoney, sum,
} from "./money.ts";
import { PayrollError } from "./payroll-error.ts";

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
 */

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

const at = (value: string) => new Date(`${value}T00:00:00Z`);
const lastDayOfMonth = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

/**
 * Completed months of continuous service between two ISO dates.
 *
 * The anniversary day matters: hired 2025-01-15, asked on 2026-01-14 is 11
 * months (not yet eligible); on 2026-01-15 it is exactly 12. A hire date past
 * the end of the asked month clamps to that month's last day, so someone hired
 * 31 January reaches one month on 28 February — the same convention every
 * handbook uses and the one anniversary arithmetic would otherwise get wrong.
 *
 * The result is signed: a date before the hire date returns a negative count,
 * so no tier (afterMonths ≥ 0) can match a period the employee had not started.
 */
export function monthsOfService(hiredOn: string, onDate: string): number {
  const hired = at(hiredOn);
  const asked = at(onDate);
  let months = (asked.getUTCFullYear() - hired.getUTCFullYear()) * 12
    + (asked.getUTCMonth() - hired.getUTCMonth());
  const anniversaryDay = Math.min(hired.getUTCDate(), lastDayOfMonth(asked));
  if (asked.getUTCDate() < anniversaryDay) months -= 1;
  return months;
}

export interface ServiceTierRow {
  id: string;
  planId: string | null;
  componentId: string | null;
  afterMonths: number;
  accrualValue: string | null;
  eligible: boolean | null;
  isActive: boolean;
}

/**
 * The rung reached on one target's ladder: the highest afterMonths ≤ service.
 * Pure. Returns null when the employee has not reached the first rung.
 */
export function pickServiceTier(
  rows: readonly ServiceTierRow[],
  months: number,
): ServiceTierRow | null {
  let best: ServiceTierRow | null = null;
  for (const row of rows) {
    if (!row.isActive) continue;
    if (row.afterMonths > months) continue;
    if (best === null || row.afterMonths > best.afterMonths) best = row;
  }
  return best;
}

/** Everything service tiers decide for one employee on one date. */
export interface ResolvedServiceTiers {
  hiredOn: string | null;
  /** Completed months of continuous service; null when no hire date is on file. */
  months: number | null;
  /** planId → accrual value the reached rung raises the plan to. */
  planAccrualValues: Map<string, string>;
  /** componentId → whether service has made the component eligible. */
  componentEligibility: Map<string, boolean>;
}

/** Group tier rows by target and resolve each ladder. Pure. */
export function resolveServiceTiersFrom(
  rows: readonly ServiceTierRow[],
  months: number | null,
  hiredOn: string | null,
): ResolvedServiceTiers {
  const planAccrualValues = new Map<string, string>();
  const componentEligibility = new Map<string, boolean>();
  if (months === null) return { hiredOn, months, planAccrualValues, componentEligibility };

  const byPlan = new Map<string, ServiceTierRow[]>();
  const byComponent = new Map<string, ServiceTierRow[]>();
  for (const row of rows) {
    if (row.planId) {
      const list = byPlan.get(row.planId) ?? [];
      list.push(row);
      byPlan.set(row.planId, list);
    } else if (row.componentId) {
      const list = byComponent.get(row.componentId) ?? [];
      list.push(row);
      byComponent.set(row.componentId, list);
    }
  }
  for (const [planId, list] of byPlan) {
    const tier = pickServiceTier(list, months);
    if (tier?.accrualValue != null) planAccrualValues.set(planId, tier.accrualValue);
  }
  for (const [componentId, list] of byComponent) {
    const tier = pickServiceTier(list, months);
    if (tier?.eligible != null) componentEligibility.set(componentId, tier.eligible);
  }
  return { hiredOn, months, planAccrualValues, componentEligibility };
}

/* ------------------------------------------------------------------ */
/* The movement kernel                                                 */
/* ------------------------------------------------------------------ */

/** A ledger row the caller is being asked to write. */
export interface EntitlementMovement {
  planId: string;
  employeePartyId: string;
  movementDate: string;
  /** Signed, in the plan's unit. */
  amount: string;
  hours: string | null;
  kind: EntitlementMovementKind;
  /** Component the movement should appear against on the stub, if any. */
  componentId: string | null;
  note: string | null;
}

export interface EntitlementWarning {
  planId: string;
  planCode: string;
  employeePartyId: string;
  /** 'near_limit' crossed notifyBalance; 'over_limit' crossed maxBalance. */
  kind: "near_limit" | "over_limit";
  balance: string;
  threshold: string;
}

export interface PlanMovementResult {
  movements: EntitlementMovement[];
  warnings: EntitlementWarning[];
  /** Balance after applying every returned movement. */
  closingBalance: string;
}

export interface PlanMovementInput {
  plan: EntitlementPlan;
  employeePartyId: string;
  movementDate: string;
  /** Balance carried into this period (SUM of the ledger before this run). */
  openingBalance: string;
  /** Bankable earnings behind a percent_of_earnings accrual. */
  earnings: string;
  /** Hours on the stub behind a per_hour_worked accrual. */
  hours: string;
  /** Resolved cap for this employee/date, or null when unlimited. */
  limit: EntitlementPlanLimit | null;
  /** Service-tier override of plan.accrualValue, when a rung has been reached. */
  serviceAccrualValue?: string | null;
  /**
   * Per-employee rate the caller already owns elsewhere — for the migrated
   * Vacation plan this is employee_payroll_profiles.vacation_percent, which
   * keeps its one home on the payroll profile rather than being copied here.
   */
  employeeAccrualValue?: string | null;
}

/**
 * One plan's movements for one stub. Pure — this is the function the payroll
 * run calls per plan and the function the tests pin.
 *
 * accrue plans earn; owe plans repay. A repayment never overshoots: it is
 * capped at the outstanding negative balance, so a $1,200 benefit debt repaid
 * at $100 a period stops dead on the twelfth period at exactly zero and never
 * turns into a credit the employee is owed.
 *
 * Caps apply only to accrue plans (an 'owe' balance is bounded by zero):
 *   warn        — record the movement, return an over_limit warning;
 *   block       — throw PayrollError, so the run reports the employee and the
 *                 operator fixes configuration rather than discovering a
 *                 breached cap after posting;
 *   auto_payout — record the accrual AND a payout of the excess, landing the
 *                 bank exactly on the cap with the difference paid out.
 */
export function computePlanMovement(input: PlanMovementInput): PlanMovementResult {
  const { plan, employeePartyId, movementDate, openingBalance, limit } = input;
  const movements: EntitlementMovement[] = [];
  const warnings: EntitlementWarning[] = [];

  // Rate precedence: a reached service rung is org POLICY and wins; below it
  // the per-employee rate wins over the plan's base. Configure a ladder and
  // you mean it — that is the whole point of a schedule.
  const accrualValue = input.serviceAccrualValue
    ?? input.employeeAccrualValue
    ?? plan.accrualValue;
  const earned = accrualValue == null ? "0" : earnedAmount(plan, accrualValue, input);

  if (plan.direction === "owe") {
    // The balance is negative; recoup toward zero and stop there.
    const outstanding = cmp(openingBalance, "0") < 0 ? neg(openingBalance) : "0";
    const repayment = cmp(earned, outstanding) > 0 ? outstanding : earned;
    if (cmp(repayment, "0") > 0) {
      movements.push({
        planId: plan.id,
        employeePartyId,
        movementDate,
        amount: repayment,
        hours: null,
        kind: "repayment",
        componentId: plan.payoutComponentId,
        note: null,
      });
    }
    return { movements, warnings, closingBalance: add(openingBalance, repayment) };
  }

  let balance = openingBalance;
  if (cmp(earned, "0") > 0) {
    const projected = add(balance, earned);
    const max = limit?.maxBalance ?? null;
    if (max != null && cmp(projected, max) > 0) {
      if (plan.capBehavior === "block") {
        throw new PayrollError(
          `entitlement plan ${plan.code} would exceed its ${max} limit `
          + `(balance ${balance} + ${earned}) — raise the limit or pay the bank down`,
        );
      }
      if (plan.capBehavior === "auto_payout") {
        const excess = add(projected, neg(max));
        movements.push(accrualMovement(plan, employeePartyId, movementDate, earned, input.hours));
        movements.push({
          planId: plan.id,
          employeePartyId,
          movementDate,
          amount: neg(excess),
          hours: null,
          kind: "payout",
          componentId: plan.payoutComponentId,
          note: `Balance capped at ${max}`,
        });
        return { movements, warnings, closingBalance: max };
      }
      // warn: the movement still happens — the cap is a policy signal, not a
      // silent data loss.
      warnings.push({
        planId: plan.id,
        planCode: plan.code,
        employeePartyId,
        kind: "over_limit",
        balance: projected,
        threshold: max,
      });
    }
    movements.push(accrualMovement(plan, employeePartyId, movementDate, earned, input.hours));
    balance = projected;
  }

  const notify = limit?.notifyBalance ?? null;
  const alreadyOver = warnings.some((w) => w.kind === "over_limit");
  if (!alreadyOver && notify != null && cmp(balance, notify) >= 0) {
    warnings.push({
      planId: plan.id,
      planCode: plan.code,
      employeePartyId,
      kind: "near_limit",
      balance,
      threshold: notify,
    });
  }
  return { movements, warnings, closingBalance: balance };
}

function accrualMovement(
  plan: EntitlementPlan,
  employeePartyId: string,
  movementDate: string,
  amount: string,
  hours: string,
): EntitlementMovement {
  return {
    planId: plan.id,
    employeePartyId,
    movementDate,
    amount,
    hours: plan.accrualMethod === "per_hour_worked" ? roundMoney(hours, 2) : null,
    kind: "accrual",
    componentId: plan.accrualComponentId,
    note: null,
  };
}

/** This period's earned (or scheduled-repayment) amount, to the cent. */
function earnedAmount(
  plan: EntitlementPlan,
  accrualValue: string,
  input: Pick<PlanMovementInput, "earnings" | "hours">,
): string {
  switch (plan.accrualMethod) {
    case "percent_of_earnings":
      return mulPercent(input.earnings, accrualValue, 2);
    case "per_hour_worked":
      return roundMoney(mulDecimal(accrualValue, input.hours), 2);
    case "fixed_per_period":
      return roundMoney(accrualValue, 2);
    case "manual":
      return "0";
  }
}

/* ------------------------------------------------------------------ */
/* Database adapters                                                   */
/* ------------------------------------------------------------------ */

type Executor = Pick<typeof db, "execute">;

function planFromRow(row: Record<string, unknown>): EntitlementPlan {
  return {
    id: String(row.id),
    code: String(row.code),
    systemKey: row.system_key === VACATION_PLAN_SYSTEM_KEY ? VACATION_PLAN_SYSTEM_KEY : null,
    name: String(row.name),
    unit: row.unit === "hours" ? "hours" : "money",
    direction: row.direction === "owe" ? "owe" : "accrue",
    accrualMethod: String(row.accrual_method) as EntitlementAccrualMethod,
    accrualValue: row.accrual_value != null ? String(row.accrual_value) : null,
    accrualComponentId: row.accrual_component_id != null ? String(row.accrual_component_id) : null,
    payoutComponentId: row.payout_component_id != null ? String(row.payout_component_id) : null,
    liabilityAccountId: row.liability_account_id != null ? String(row.liability_account_id) : null,
    capBehavior: String(row.cap_behavior) as EntitlementCapBehavior,
  };
}

/** Active plans for an org, in code order. */
export async function entitlementPlans(
  orgId: string,
  executor: Executor = db,
): Promise<EntitlementPlan[]> {
  const r = (await executor.execute<Record<string, unknown>>(sql`
    select * from entitlement_plans
     where org_id = ${orgId} and is_active
     order by code
  `));
  return r.rows.map(planFromRow);
}

/**
 * The org's vacation plan, resolved on its ENGINE BINDING. Pure.
 *
 * Never `code`: that column is typed by the operator in the Setup drawer, and
 * matching on it meant a tenant who named the plan "VACATION" (or who had
 * simply never run the migration that created a "VAC" row) silently stopped
 * accruing vacation — 4% of gross, forever, with an understated liability and
 * no error anywhere. See `assertVacationPlanResolved` for the other half of
 * that fix: a missing plan is now loud.
 */
export function vacationPlanOf(
  plans: readonly EntitlementPlan[],
): EntitlementPlan | null {
  return plans.find((plan) => plan.systemKey === VACATION_PLAN_SYSTEM_KEY) ?? null;
}

/** The scope keys an employee competes on — the wage resolver's inputs. */
async function employeeScope(
  executor: Executor, orgId: string, employeePartyId: string,
): Promise<EntitlementScopeKeys> {
  const r = (await executor.execute<{
      job_title: string | null; trade_id: string | null;
      department_id: string | null; subsidiary_id: string | null;
    }>(sql`
    select er.job_title, er.trade_id, er.department_id, p.subsidiary_id
      from parties p
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
     where p.org_id = ${orgId} and p.id = ${employeePartyId}
  `));
  const row = r.rows[0];
  return {
    employeePartyId,
    jobTitle: row?.job_title ?? null,
    tradeId: row?.trade_id ?? null,
    departmentId: row?.department_id ?? null,
    subsidiaryId: row?.subsidiary_id ?? null,
  };
}

/**
 * The most-specific effective limit for one plan and employee on a date.
 * Candidate rows are loaded once and ranked by the pure kernel, so the
 * precedence lives in exactly one place and is unit-tested without a DB.
 */
export async function resolvePlanLimit(
  executor: Executor,
  orgId: string,
  planId: string,
  employeePartyId: string,
  onDate: string,
  /** Pre-loaded scope keys — a pay run resolves them once per employee. */
  knownScope?: EntitlementScopeKeys,
): Promise<EntitlementPlanLimit | null> {
  const scope = knownScope ?? await employeeScope(executor, orgId, employeePartyId);
  const r = (await executor.execute<Record<string, unknown>>(sql`
    select id, plan_id, employee_party_id, job_title, trade_id, department_id, subsidiary_id,
           max_balance, notify_balance, effective_from, effective_to, is_active
      from entitlement_plan_limits
     where org_id = ${orgId} and plan_id = ${planId} and is_active
       and effective_from <= ${onDate}
       and (effective_to is null or effective_to >= ${onDate})
  `));
  const rows: EntitlementLimitRow[] = r.rows.map((row) => ({
    id: String(row.id),
    planId: String(row.plan_id),
    employeePartyId: row.employee_party_id != null ? String(row.employee_party_id) : null,
    jobTitle: row.job_title != null ? String(row.job_title) : null,
    tradeId: row.trade_id != null ? String(row.trade_id) : null,
    departmentId: row.department_id != null ? String(row.department_id) : null,
    subsidiaryId: row.subsidiary_id != null ? String(row.subsidiary_id) : null,
    maxBalance: row.max_balance != null ? String(row.max_balance) : null,
    notifyBalance: row.notify_balance != null ? String(row.notify_balance) : null,
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to != null ? String(row.effective_to).slice(0, 10) : null,
    isActive: row.is_active !== false,
  }));
  return pickPlanLimit(rows, scope, onDate);
}

/**
 * Months of continuous service (from employee_roles.hired_on) and everything
 * the reached rungs decide: raised plan accrual values and the pay components
 * service has made the employee eligible for.
 */
export async function resolveServiceTier(
  executor: Executor,
  orgId: string,
  employeePartyId: string,
  onDate: string,
): Promise<ResolvedServiceTiers> {
  const hire = (await executor.execute<{ hired_on: string | null }>(sql`
    select hired_on from employee_roles
     where org_id = ${orgId} and party_id = ${employeePartyId}
  `));
  const hiredOn = hire.rows[0]?.hired_on ? String(hire.rows[0].hired_on).slice(0, 10) : null;
  const tiers = (await executor.execute<Record<string, unknown>>(sql`
    select id, plan_id, component_id, after_months, accrual_value, eligible, is_active
      from entitlement_service_tiers
     where org_id = ${orgId} and is_active
     order by after_months
  `));
  const rows: ServiceTierRow[] = tiers.rows.map((row) => ({
    id: String(row.id),
    planId: row.plan_id != null ? String(row.plan_id) : null,
    componentId: row.component_id != null ? String(row.component_id) : null,
    afterMonths: Number(row.after_months),
    accrualValue: row.accrual_value != null ? String(row.accrual_value) : null,
    eligible: row.eligible == null ? null : row.eligible === true || row.eligible === "true",
    isActive: row.is_active !== false,
  }));
  const months = hiredOn ? monthsOfService(hiredOn, onDate) : null;
  return resolveServiceTiersFrom(rows, months, hiredOn);
}

export interface EntitlementBalance {
  plan: EntitlementPlan;
  /** SUM(entitlement_ledger.amount), in the plan's unit. */
  balance: string;
  /** The balance expressed in money; null when an hours plan has no wage. */
  balanceMoney: string | null;
  /** The balance expressed in hours at that wage; null when no wage resolves. */
  balanceHours: string | null;
  /** Wage the money↔hours view was computed at. */
  wage: string | null;
  limit: EntitlementPlanLimit | null;
  overLimit: boolean;
  nearLimit: boolean;
  lastMovementDate: string | null;
}

/**
 * Per-plan balances for one employee, with the money and hours views. `asOf`
 * bounds movementDate, so a period-end statement is exact.
 *
 * The hours view is a DISPLAY of the money balance at today's wage — the two
 * are not independent facts. That is the whole point: 50 banked hours earned
 * at $32 are $1,600 of liability, and they buy 42.1 hours once the wage
 * reaches $38. The number that stays true is the money.
 *
 * `executor` and `excludeRunDocumentId` exist so a PAY RUN can read balances
 * the same way `planBalanceExcludingRun` does — inside its own transaction,
 * and net of its own movements. Reading without either is what made a
 * recalculated termination run pay nothing: the first Calculate's `−balance`
 * payout was still in the sum.
 */
export async function entitlementBalances(
  orgId: string,
  employeePartyId: string,
  asOf?: string,
  opts: {
    executor?: Executor;
    /** Ignore this run's own movements — required from inside a calculation. */
    excludeRunDocumentId?: string | null;
    /** Plans to report on; loaded from the org when omitted. */
    plans?: readonly EntitlementPlan[];
  } = {},
): Promise<EntitlementBalance[]> {
  const executor = opts.executor ?? db;
  const excludeRunDocumentId = opts.excludeRunDocumentId ?? null;
  const plans = opts.plans ?? await entitlementPlans(orgId, executor);
  if (plans.length === 0) return [];
  const onDate = asOf ?? (await businessToday(orgId));
  const sums = (await executor.execute<{ plan_id: string; balance: string; last_movement: string | null }>(sql`
    select plan_id, sum(amount) as balance, max(movement_date) as last_movement
      from entitlement_ledger
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}
       and movement_date <= ${onDate}
       and (${excludeRunDocumentId}::uuid is null
            or pay_run_document_id is distinct from ${excludeRunDocumentId}::uuid)
     group by plan_id
  `));
  const byPlan = new Map(sums.rows.map((row) => [row.plan_id, row]));

  // One wage lookup serves every plan's hours view.
  const { resolveWage } = await import("./labor-costing.ts");
  const resolved = await resolveWage(orgId, employeePartyId, onDate);
  const wage = resolved && cmp(resolved.wage, "0") > 0 ? resolved.wage : null;
  const scope = await employeeScope(executor, orgId, employeePartyId);

  const balances: EntitlementBalance[] = [];
  for (const plan of plans) {
    const row = byPlan.get(plan.id);
    const balance = row ? roundMoney(String(row.balance), 4) : "0.0000";
    const limit = await resolvePlanLimit(executor, orgId, plan.id, employeePartyId, onDate, scope);
    const balanceMoney = plan.unit === "money"
      ? balance
      : (wage ? roundMoney(mulDecimal(balance, wage), 2) : null);
    const balanceHours = plan.unit === "hours"
      ? balance
      // `wage ?` does not screen a zero wage — the string "0" is truthy — and
      // divRate then rejected it as an invalid FX rate. Money cannot be
      // expressed as hours at a zero wage, so report no hours instead.
      : (wage && !isZero(String(wage)) ? div(balance, String(wage)) : null);
    balances.push({
      plan,
      balance,
      balanceMoney,
      balanceHours,
      wage,
      limit,
      overLimit: limit?.maxBalance != null && cmp(balance, limit.maxBalance) > 0,
      nearLimit: limit?.notifyBalance != null && cmp(balance, limit.notifyBalance) >= 0,
      lastMovementDate: row?.last_movement ? String(row.last_movement).slice(0, 10) : null,
    });
  }
  return balances;
}

/**
 * Balance for one plan before a given run's own movements are counted.
 *
 * This — not `entitlementBalances` — is what a pay run must read, for two
 * reasons, both of which silently lost money when a caller used the other one:
 *
 *  - it takes an EXECUTOR, so the read happens inside the calculation's
 *    transaction and sees the stubs and movements that transaction has
 *    written; `entitlementBalances` runs on the pooled connection and cannot.
 *  - it EXCLUDES the run's own movements, so recalculating converges. A
 *    termination run writes a `−balance` payout; read back without the
 *    exclusion, the second Calculate nets to zero and silently drops the
 *    departing employee's entire accrued balance from their final cheque.
 */
export async function planBalanceExcludingRun(
  executor: Executor,
  orgId: string,
  planId: string,
  employeePartyId: string,
  onDate: string,
  excludeRunDocumentId: string | null,
): Promise<string> {
  const r = (await executor.execute<{ balance: string }>(sql`
    select coalesce(sum(amount), 0) as balance
      from entitlement_ledger
     where org_id = ${orgId} and plan_id = ${planId}
       and employee_party_id = ${employeePartyId}
       and movement_date <= ${onDate}
       and (${excludeRunDocumentId}::uuid is null
            or pay_run_document_id is distinct from ${excludeRunDocumentId}::uuid)
  `));
  return roundMoney(String(r.rows[0]?.balance ?? "0"), 4);
}

export interface StubEarningLine {
  componentId: string | null;
  amount: string;
  hours?: string | null;
  /** Earnings excluded from bankable pay (a vacation payout is not vacationable). */
  bankable?: boolean;
}

export interface StubMovementPlan {
  movements: EntitlementMovement[];
  warnings: EntitlementWarning[];
}

/**
 * Every plan's movements for one employee's stub.
 *
 * Given the stub's earning lines this returns the accrual, repayment, and
 * capped-payout movements the run should record — it writes nothing. The pay
 * run calls this while it still has the lines in hand, adds the returned
 * `componentId` movements to the stub as lines, and calls
 * recordEntitlementMovements inside the same transaction.
 *
 * Service tiers are applied first: a 10-year employee's vacation plan accrues
 * at the rung's rate, not the plan's base rate, for this and every future run.
 */
export async function planMovementsForStub(
  executor: Executor,
  input: {
    orgId: string;
    employeePartyId: string;
    /** Pay date; the movement date and the date every rule resolves on. */
    movementDate: string;
    /** Run whose prior movements must not be double-counted on recalculation. */
    payRunDocumentId: string | null;
    earnings: readonly StubEarningLine[];
    /** Plans to consider; loaded from the org when omitted. */
    plans?: readonly EntitlementPlan[];
    /** planId → per-employee rate the caller owns (vacation_percent, …). */
    employeeAccrualValues?: ReadonlyMap<string, string>;
  },
): Promise<StubMovementPlan> {
  const { orgId, employeePartyId, movementDate, payRunDocumentId } = input;
  const plans = input.plans ?? (await entitlementPlans(orgId, executor));
  if (plans.length === 0) return { movements: [], warnings: [] };

  const bankable = input.earnings.filter((line) => line.bankable !== false);
  const earnings = sum(bankable.map((line) => line.amount));
  const hours = sum(
    input.earnings.filter((line) => line.hours != null).map((line) => String(line.hours)),
  );

  const tiers = await resolveServiceTier(executor, orgId, employeePartyId, movementDate);
  // One scope lookup serves every plan's limit resolution for this employee.
  const scope = await employeeScope(executor, orgId, employeePartyId);
  const movements: EntitlementMovement[] = [];
  const warnings: EntitlementWarning[] = [];
  for (const plan of plans) {
    const openingBalance = await planBalanceExcludingRun(
      executor, orgId, plan.id, employeePartyId, movementDate, payRunDocumentId,
    );
    const limit = await resolvePlanLimit(
      executor, orgId, plan.id, employeePartyId, movementDate, scope,
    );
    const result = computePlanMovement({
      plan,
      employeePartyId,
      movementDate,
      openingBalance,
      earnings,
      hours,
      limit,
      serviceAccrualValue: tiers.planAccrualValues.get(plan.id) ?? null,
      employeeAccrualValue: input.employeeAccrualValues?.get(plan.id) ?? null,
    });
    movements.push(...result.movements);
    warnings.push(...result.warnings);
  }
  return { movements, warnings };
}

/**
 * Append one EMPLOYEE'S movements to the ledger, replacing whatever that
 * employee's previous pass on the same run wrote.
 *
 * The unit of replacement is the (run, EMPLOYEE) pair, never the run — because
 * the caller is per employee. `calculateStub` runs once per person, so a
 * run-wide delete here meant employee 2's call erased employee 1's rows: after
 * a 40-person run only the last employee had ledger rows at all, while all 40
 * stubs carried the accrual line and the GL carried the credit. Every other
 * employee's bank was silently short, forever.
 *
 * `employeePartyIds` is therefore REQUIRED whenever `payRunDocumentId` is set,
 * and must name every employee being rewritten — including one whose recompute
 * produced NO movements, whose stale rows must still go. The schema states the
 * same intent: `entitlement_ledger_run_movement` is unique on
 * (run, plan, employee, kind).
 *
 * Run-level cleanup (an employee who dropped off the run entirely) belongs to
 * `calculatePayRun`, which deletes the run's movements alongside its stubs.
 */
export async function recordEntitlementMovements(
  executor: Executor,
  input: {
    orgId: string;
    actorId: string | null;
    payRunDocumentId: string | null;
    /** Employees whose run-sourced movements this call replaces. */
    employeePartyIds?: readonly string[];
    movements: readonly EntitlementMovement[];
    /** Stub line ids by plan+kind, when the run materialized them as lines. */
    stubLineIds?: ReadonlyMap<string, string>;
  },
): Promise<number> {
  const { orgId, actorId, payRunDocumentId } = input;
  if (payRunDocumentId) {
    const employeePartyIds = [
      ...new Set([
        ...(input.employeePartyIds ?? []),
        ...input.movements.map((movement) => movement.employeePartyId),
      ]),
    ];
    if (employeePartyIds.length === 0) {
      throw new PayrollError(
        "recordEntitlementMovements needs the employees whose run movements it replaces "
        + "— a run-wide delete would drop every other employee's ledger rows",
      );
    }
    await executor.execute(sql`
      delete from entitlement_ledger
       where org_id = ${orgId} and pay_run_document_id = ${payRunDocumentId}
         and employee_party_id = any(${`{${employeePartyIds.join(",")}}`}::uuid[])
    `);
  }
  for (const movement of input.movements) {
    const stubLineId = input.stubLineIds?.get(`${movement.planId}:${movement.kind}`) ?? null;
    await executor.execute(sql`
      insert into entitlement_ledger (org_id, plan_id, employee_party_id, movement_date, amount,
                                      hours, kind, pay_run_document_id, stub_line_id, note,
                                      created_by, updated_by)
      values (${orgId}, ${movement.planId}, ${movement.employeePartyId}, ${movement.movementDate},
              ${movement.amount}, ${movement.hours}, ${movement.kind}, ${payRunDocumentId},
              ${stubLineId}, ${movement.note}, ${actorId}, ${actorId})
    `);
  }
  return input.movements.length;
}

/* ------------------------------------------------------------------ */
/* Mid-year adoption: opening balances for a bank                       */
/* ------------------------------------------------------------------ */

/**
 * The third dimension of a mid-year carry-in (the statutory and per-component
 * ones live in engine/src/payroll-opening-balances.ts).
 *
 * An employer adopting OpenBooks mid-year does not only carry in CPP and EI.
 * Every employee also arrives holding a vacation bank and, often, banked
 * overtime — a real liability the employer already owes. Since vacation moved
 * onto the entitlement ledger, `payroll_opening_balances.vacation_balance` is
 * dead to the engine and there was NO load path at all: every bank started at
 * zero, so the balance sheet understated the liability, and a termination in the
 * first year paid out only what accrued after adoption. For a ten-year employee
 * that is most of their entitlement, silently.
 *
 * Shape, and why it is not a table:
 *
 *  - the carry-in IS an `entitlement_ledger` movement with `kind = 'opening'`,
 *    which the schema already reserved and the vacation migration already
 *    writes. Balance = SUM(ledger), and a separate opening table would be a
 *    second source of truth for the same number;
 *  - it is NOT year-scoped, unlike the statutory carry-in. A bank has one
 *    lifetime balance, not an annual one, so `entitlement_ledger_opening` is
 *    unique on (org, plan, employee) with no tax year — and the UI keeps it out
 *    of the year-scoped grid for exactly that reason;
 *  - `movementDate` is the adoption date. It matters: the pay run sums
 *    `movement_date <= pay_date`, so a carry-in dated after a run is invisible
 *    to it, and one dated before a COMMITTED run would restate a balance that
 *    run already paid from. That is the lock, below.
 */
export interface EntitlementOpeningLock {
  documentNumber: string | null;
  payDate: string;
}

export interface EntitlementOpeningRow {
  employeePartyId: string;
  employeeName: string;
  employeeNumber: string | null;
  /** planId → carried-in amount, in the plan's unit. Only where one exists. */
  amounts: Record<string, string>;
  /** planId → the adoption date the carry-in is dated. */
  dates: Record<string, string>;
  /** planId → the committed run that froze it, where one has. */
  locked: Record<string, EntitlementOpeningLock>;
  /**
   * Non-zero `payroll_opening_balances.vacation_balance` with no matching
   * opening movement: a legacy carry-in nobody migrated. Surfaced rather than
   * left to rot — it is money the employer owes that no balance shows.
   */
  legacyVacationBalance: string | null;
}

export interface EntitlementOpeningsResult {
  /** Active plans, in code order — the columns of the grid. */
  plans: EntitlementPlan[];
  rows: EntitlementOpeningRow[];
  /** Employees carrying at least one opening. */
  entered: number;
  /** The date new carry-ins will be dated unless the operator changes it. */
  asOf: string;
  /**
   * Employees a committed run on or after `asOf` already paid, so a NEW
   * carry-in dated then would restate a balance that run computed from.
   */
  blocked: Record<string, EntitlementOpeningLock>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertMovementDate(value: unknown): string {
  const date = String(value ?? "").trim().slice(0, 10);
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new PayrollError(`"${String(value)}" is not a date (YYYY-MM-DD)`);
  }
  return date;
}

/**
 * Openings a committed run has already consumed, per (plan, employee).
 *
 * The test is the ENGINE's read predicate, not a proxy for it:
 * `planBalanceExcludingRun` sums `movement_date <= onDate`, so a committed run
 * included this carry-in exactly when it has a stub for the employee dated on or
 * after the carry-in's movement date. Anything looser would freeze carry-ins no
 * run ever read (blocking a correctable typo behind a void); anything tighter
 * would let an edit restate money that has left the bank.
 */
export async function entitlementOpeningLocks(
  orgId: string,
  executor: Executor = db,
): Promise<Map<string, EntitlementOpeningLock>> {
  const r = (await executor.execute<{ plan_id: string; employee_party_id: string; document_number: string | null; pay_date: string }>(sql`
    select distinct on (l.plan_id, l.employee_party_id)
           l.plan_id, l.employee_party_id, d.document_number, s.pay_date::text as pay_date
      from entitlement_ledger l
      join pay_stubs s on s.org_id = l.org_id and s.employee_party_id = l.employee_party_id
                      and s.pay_date >= l.movement_date
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      left join documents d on d.id = r.document_id and d.org_id = r.org_id
     where l.org_id = ${orgId} and l.kind = 'opening' and r.run_status = 'committed'
     order by l.plan_id, l.employee_party_id, s.pay_date
  `));
  return new Map(
    r.rows.map((row) => [
      `${row.plan_id}:${row.employee_party_id}`,
      { documentNumber: row.document_number, payDate: row.pay_date },
    ]),
  );
}

/**
 * Employees a committed run on or after `asOf` has already paid. Adding a
 * carry-in dated then would change the balance that run's stub was computed
 * from, which no recalculation can put back — so a NEW opening is refused for
 * them, with the run named.
 */
export async function entitlementOpeningBlocks(
  orgId: string,
  asOf: string,
  executor: Executor = db,
): Promise<Map<string, EntitlementOpeningLock>> {
  const r = (await executor.execute<{ employee_party_id: string; document_number: string | null; pay_date: string }>(sql`
    select distinct on (s.employee_party_id)
           s.employee_party_id, d.document_number, s.pay_date::text as pay_date
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      left join documents d on d.id = r.document_id and d.org_id = r.org_id
     where s.org_id = ${orgId} and r.run_status = 'committed' and s.pay_date >= ${asOf}
     order by s.employee_party_id, s.pay_date
  `));
  return new Map(
    r.rows.map((row) => [
      row.employee_party_id,
      { documentNumber: row.document_number, payDate: row.pay_date },
    ]),
  );
}

/**
 * Every active employee's bank carry-ins, plus the plans that need one.
 *
 * Employees WITHOUT a carry-in are returned too, exactly as the statutory grid
 * does: an empty screen that has to be discovered person by person is how a
 * ten-year employee's vacation bank gets left at zero.
 */
export async function entitlementOpenings(
  orgId: string,
  opts: { asOf?: string } = {},
): Promise<EntitlementOpeningsResult> {
  const asOf = opts.asOf ? assertMovementDate(opts.asOf) : await businessToday(orgId);
  const plans = await entitlementPlans(orgId);

  const people = (await db.execute<Record<string, unknown>>(sql`
    select p.id as employee_party_id, p.display_name as employee_name, er.employee_number,
           coalesce((
             select b.vacation_balance from payroll_opening_balances b
              where b.org_id = p.org_id and b.employee_party_id = p.id
                and b.vacation_balance <> 0
              order by b.tax_year desc limit 1), 0)::text as legacy_vacation
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join employee_roles er on er.party_id = p.id and er.org_id = prof.org_id
     where prof.org_id = ${orgId} and prof.is_active and p.is_active
     order by p.display_name
  `));

  const openings = (await db.execute<{ plan_id: string; employee_party_id: string; amount: string; movement_date: string }>(sql`
    select plan_id, employee_party_id, amount::text as amount, movement_date::text as movement_date
      from entitlement_ledger
     where org_id = ${orgId} and kind = 'opening'
  `));
  const byEmployee = new Map<string, typeof openings.rows>();
  for (const row of openings.rows) {
    byEmployee.set(row.employee_party_id, [...(byEmployee.get(row.employee_party_id) ?? []), row]);
  }

  const locks = await entitlementOpeningLocks(orgId);
  const blocks = await entitlementOpeningBlocks(orgId, asOf);
  const vacationPlan = vacationPlanOf(plans);

  const rows: EntitlementOpeningRow[] = people.rows.map((raw) => {
    const employeePartyId = String(raw.employee_party_id);
    const amounts: Record<string, string> = {};
    const dates: Record<string, string> = {};
    const locked: Record<string, EntitlementOpeningLock> = {};
    for (const row of byEmployee.get(employeePartyId) ?? []) {
      amounts[row.plan_id] = roundMoney(String(row.amount), 4);
      dates[row.plan_id] = String(row.movement_date).slice(0, 10);
      const lock = locks.get(`${row.plan_id}:${employeePartyId}`);
      if (lock) locked[row.plan_id] = lock;
    }
    // Only a legacy value with nothing carried in against the vacation plan is
    // unmigrated. Once the opening exists the column has been dealt with.
    const legacy = roundMoney(String(raw.legacy_vacation ?? "0"), 4);
    const unmigrated = cmp(legacy, "0") !== 0
      && (vacationPlan === null || amounts[vacationPlan.id] === undefined);
    return {
      employeePartyId,
      employeeName: String(raw.employee_name ?? ""),
      employeeNumber: raw.employee_number == null ? null : String(raw.employee_number),
      amounts,
      dates,
      locked,
      legacyVacationBalance: unmigrated ? legacy : null,
    };
  });

  return {
    plans,
    rows,
    entered: rows.filter((row) => Object.keys(row.amounts).length > 0).length,
    asOf,
    blocked: Object.fromEntries(blocks),
  };
}

export interface EntitlementOpeningWrite {
  employeePartyId: string;
  /** planId OR plan code → amount in the plan's unit; blank or zero clears it. */
  amounts: Record<string, unknown>;
}

export interface EntitlementOpeningSaveResult {
  created: number;
  updated: number;
  deleted: number;
  /** Nothing is written when this is non-empty. */
  errors: { employeePartyId: string; employeeName?: string; message: string }[];
  /** Written, but worth an operator's attention (a carry-in above its cap). */
  warnings: { employeePartyId: string; employeeName?: string; message: string }[];
}

/**
 * Carries every rejected row out of the aborted transaction.
 *
 * `PayrollError` now lives in its own import-free module (payroll-error.ts)
 * precisely so this `extends` is safe: it used to live in payroll-run.ts, which
 * imports THIS module, so the class expression evaluated before the base
 * existed — `ReferenceError: Cannot access 'PayrollError' before
 * initialization`, at import time, for every consumer.
 */
export class EntitlementOpeningSaveError extends PayrollError {
  constructor(readonly result: EntitlementOpeningSaveResult) {
    super(result.errors[0]?.message ?? "entitlement opening balances were rejected");
    this.name = "EntitlementOpeningSaveError";
  }
}

/**
 * Create or replace bank carry-ins, all-or-nothing, through the ledger.
 *
 * The same three controls the statutory carry-in has, for the same reasons:
 *
 *  1. ALL-OR-NOTHING. Half a workforce's vacation banks carried in and half at
 *     zero is harder to find than an outright failure.
 *  2. IMMUTABLE ONCE CONSUMED. A carry-in a committed run has already read is
 *     inside a cheque; correcting it is a void-and-restate exercise, so this
 *     refuses and names the run. Enforced in the database too — the
 *     `entitlement_ledger` append-only trigger carries the same predicate, so
 *     the control does not depend on every caller coming through here.
 *  3. ZERO IS A DELETE. "No carry-in" and "a carry-in of nothing" are one fact.
 *
 * Replacement is DELETE + INSERT rather than an UPDATE: the ledger refuses
 * UPDATE unconditionally and that is right — a movement's amount is never
 * rewritten in place. An opening no run has read is not history yet, which is
 * the one narrow case the trigger permits deleting.
 *
 * Sign is checked against the plan's DIRECTION rather than quietly normalized:
 * an `accrue` bank the employer owes runs positive, an `owe` balance the
 * employee is repaying runs negative, and a hidden negation here would turn a
 * $1,200 benefit debt into a $1,200 credit on a real cheque.
 */
export async function saveEntitlementOpenings(input: {
  orgId: string;
  actorId: string;
  /** Adoption date every carry-in in this load is dated. */
  movementDate: string;
  rows: EntitlementOpeningWrite[];
  note?: string | null;
  /** Reject (rather than skip) carry-ins a committed run consumed. Default true. */
  strictLocks?: boolean;
}): Promise<EntitlementOpeningSaveResult> {
  const movementDate = assertMovementDate(input.movementDate);
  const result: EntitlementOpeningSaveResult = {
    created: 0, updated: 0, deleted: 0, errors: [], warnings: [],
  };
  if (input.rows.length === 0) return result;

  return db.transaction(async (tx) => {
    const plans = await entitlementPlans(input.orgId, tx);
    if (plans.length === 0) {
      throw new PayrollError(
        "this organization has no active entitlement plans, so there is no bank to carry a "
        + "balance into — configure a plan first",
      );
    }
    const planByKey = new Map<string, EntitlementPlan>();
    for (const plan of plans) {
      planByKey.set(plan.id, plan);
      planByKey.set(plan.code.trim().toLowerCase(), plan);
    }

    const names = (await tx.execute<{ id: string; display_name: string }>(sql`
      select p.id, p.display_name from parties p
       where p.org_id = ${input.orgId} and p.id in (
         select (value->>'id')::uuid from jsonb_array_elements(${JSON.stringify(
           input.rows.map((r) => ({ id: r.employeePartyId })),
         )}::jsonb) as value)
    `));
    const nameById = new Map(names.rows.map((r) => [r.id, r.display_name]));

    const existing = (await tx.execute<{ plan_id: string; employee_party_id: string; amount: string }>(sql`
      select plan_id, employee_party_id, amount::text as amount
        from entitlement_ledger
       where org_id = ${input.orgId} and kind = 'opening'
    `));
    const storedKeys = new Set(existing.rows.map((r) => `${r.plan_id}:${r.employee_party_id}`));

    const locks = await entitlementOpeningLocks(input.orgId, tx);
    const blocks = await entitlementOpeningBlocks(input.orgId, movementDate, tx);

    const seen = new Set<string>();
    const planned: {
      employeePartyId: string;
      employeeName: string;
      /** planId → amount, or null to clear. */
      amounts: Map<string, string | null>;
    }[] = [];

    for (const row of input.rows) {
      const employeeName = nameById.get(row.employeePartyId);
      const fail = (message: string) =>
        result.errors.push({ employeePartyId: row.employeePartyId, employeeName, message });
      if (!employeeName) {
        fail("employee not found in this organization");
        continue;
      }
      if (seen.has(row.employeePartyId)) {
        fail("appears more than once in this load");
        continue;
      }
      seen.add(row.employeePartyId);

      const amounts = new Map<string, string | null>();
      for (const [rawKey, raw] of Object.entries(row.amounts)) {
        const key = String(rawKey).trim();
        const plan = planByKey.get(key) ?? planByKey.get(key.toLowerCase());
        if (!plan) {
          fail(`"${key}" is not an active entitlement plan in this organization`);
          continue;
        }
        const stored = storedKeys.has(`${plan.id}:${row.employeePartyId}`);
        const lock = locks.get(`${plan.id}:${row.employeePartyId}`);
        if (lock) {
          if (input.strictLocks !== false) {
            fail(
              `a pay run committed on ${lock.payDate}`
              + `${lock.documentNumber ? ` (${lock.documentNumber})` : ""} already used the `
              + `${plan.code} carry-in; void that run before changing it`,
            );
          }
          continue;
        }

        let value: string;
        try {
          value = normalizeMoney(String(raw ?? "").trim().replace(/[,$]/g, "") || "0");
        } catch {
          fail(`${plan.code} carry-in is not an amount: "${String(raw)}"`);
          continue;
        }
        if (cmp(value, "0") === 0) {
          if (stored) amounts.set(plan.id, null);
          continue;
        }
        if (plan.direction === "accrue" && cmp(value, "0") < 0) {
          fail(
            `${plan.code} is a bank the employer owes the employee, so its carry-in cannot be `
            + "negative",
          );
          continue;
        }
        if (plan.direction === "owe" && cmp(value, "0") > 0) {
          fail(
            `${plan.code} is a balance the EMPLOYEE owes, so its carry-in must be negative `
            + `(enter ${neg(value)} for an outstanding ${value})`,
          );
          continue;
        }
        // Inserting a carry-in dated on or before a committed run would change
        // the balance that run's stub was computed from. Nothing can put that
        // back, so it is refused rather than warned about.
        const block = blocks.get(row.employeePartyId);
        if (block && !stored) {
          fail(
            `a pay run committed on ${block.payDate}`
            + `${block.documentNumber ? ` (${block.documentNumber})` : ""} already paid this `
            + `employee on or after ${movementDate}; date the carry-in after it, or void the run`,
          );
          continue;
        }
        amounts.set(plan.id, value);

        // A carry-in above the resolved cap is legitimate at adoption (the cap
        // was configured for the future), so it is reported, never refused —
        // refusing would make an accurate liability impossible to record.
        const limit = await resolvePlanLimit(
          tx, input.orgId, plan.id, row.employeePartyId, movementDate,
        );
        if (limit?.maxBalance != null && cmp(value, limit.maxBalance) > 0) {
          result.warnings.push({
            employeePartyId: row.employeePartyId,
            employeeName,
            message: `${plan.code} carry-in ${value} is above the ${limit.maxBalance} limit that `
              + `resolves for this employee (${limit.scope} scope)`,
          });
        }
      }
      planned.push({ employeePartyId: row.employeePartyId, employeeName, amounts });
    }

    if (result.errors.length > 0) throw new EntitlementOpeningSaveError(result);

    for (const row of planned) {
      for (const [planId, amount] of row.amounts) {
        const stored = storedKeys.has(`${planId}:${row.employeePartyId}`);
        if (stored) {
          // The trigger permits this exactly while no committed run has read it.
          await tx.execute(sql`
            delete from entitlement_ledger
             where org_id = ${input.orgId} and plan_id = ${planId}
               and employee_party_id = ${row.employeePartyId} and kind = 'opening'`);
        }
        if (amount === null) {
          result.deleted++;
          await auditEntitlementOpening(tx, {
            orgId: input.orgId, actorId: input.actorId, action: "delete",
            changes: { planId, employeePartyId: row.employeePartyId },
          });
          continue;
        }
        // One insert path for every ledger write in this module.
        await recordEntitlementMovements(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          payRunDocumentId: null,
          movements: [{
            planId,
            employeePartyId: row.employeePartyId,
            movementDate,
            amount,
            hours: null,
            kind: "opening",
            componentId: null,
            note: input.note ?? "Mid-year adoption carry-in",
          }],
        });
        if (stored) result.updated++;
        else result.created++;
        await auditEntitlementOpening(tx, {
          orgId: input.orgId, actorId: input.actorId,
          action: stored ? "update" : "insert",
          changes: { planId, employeePartyId: row.employeePartyId, movementDate, after: amount },
        });
      }
    }

    return result;
  });
}

async function auditEntitlementOpening(
  runner: Executor,
  args: {
    orgId: string; actorId: string | null;
    action: "insert" | "update" | "delete";
    changes: Record<string, unknown>;
  },
): Promise<void> {
  // The ledger row id changes on every replacement (delete + insert), so the
  // audit trail is keyed to the PLAN — the thing whose balance moved and the
  // thing an auditor asks about.
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'entitlement_ledger', ${String(args.changes.planId)}, ${args.action},
            ${JSON.stringify({ kind: "opening", ...args.changes })}, ${args.actorId})`);
}

export interface NearLimitEmployee {
  planId: string;
  planCode: string;
  planName: string;
  unit: EntitlementUnit;
  employeePartyId: string;
  employeeName: string;
  balance: string;
  maxBalance: string | null;
  notifyBalance: string | null;
  limitScope: EntitlementLimitScope | null;
  overLimit: boolean;
}

/**
 * Everyone whose bank has reached its notify threshold (or breached its cap)
 * — the operational list behind the Entitlement balances report and the
 * pre-run readiness check. Limits resolve per employee, so a Foreman near
 * $5,000 and a Superintendent near $6,000 both surface correctly.
 */
export async function employeesNearLimit(
  orgId: string,
  opts: { asOf?: string; planId?: string } = {},
): Promise<NearLimitEmployee[]> {
  const onDate = opts.asOf ?? (await businessToday(orgId));
  const rows = (await db.execute<{
      plan_id: string; plan_code: string; plan_name: string; unit: string;
      employee_party_id: string; employee_name: string; balance: string;
    }>(sql`
    select l.plan_id, pl.code as plan_code, pl.name as plan_name, pl.unit,
           l.employee_party_id, p.display_name as employee_name,
           sum(l.amount) as balance
      from entitlement_ledger l
      join entitlement_plans pl on pl.id = l.plan_id and pl.org_id = l.org_id and pl.is_active
      join parties p on p.id = l.employee_party_id and p.org_id = l.org_id
     where l.org_id = ${orgId} and l.movement_date <= ${onDate}
       and (${opts.planId ?? null}::uuid is null or l.plan_id = ${opts.planId ?? null}::uuid)
     group by l.plan_id, pl.code, pl.name, pl.unit, l.employee_party_id, p.display_name
     having sum(l.amount) <> 0
     order by pl.code, p.display_name
  `));

  const results: NearLimitEmployee[] = [];
  for (const row of rows.rows) {
    const limit = await resolvePlanLimit(db, orgId, row.plan_id, row.employee_party_id, onDate);
    if (!limit) continue;
    const balance = roundMoney(String(row.balance), 4);
    const overLimit = limit.maxBalance != null && cmp(balance, limit.maxBalance) > 0;
    const near = limit.notifyBalance != null && cmp(balance, limit.notifyBalance) >= 0;
    if (!overLimit && !near) continue;
    results.push({
      planId: row.plan_id,
      planCode: row.plan_code,
      planName: row.plan_name,
      unit: row.unit === "hours" ? "hours" : "money",
      employeePartyId: row.employee_party_id,
      employeeName: row.employee_name,
      balance,
      maxBalance: limit.maxBalance,
      notifyBalance: limit.notifyBalance,
      limitScope: limit.scope,
      overLimit,
    });
  }
  return results;
}

export interface ServiceMilestone {
  employeePartyId: string;
  employeeName: string;
  hiredOn: string;
  afterMonths: number;
  milestoneDate: string;
  /** Plan whose accrual the milestone raises, when the tier targets a plan. */
  planId: string | null;
  planName: string | null;
  accrualValue: string | null;
  /** Component the milestone makes the employee eligible for, when targeted. */
  componentId: string | null;
  componentName: string | null;
  eligible: boolean | null;
}

/**
 * Service milestones whose anniversary falls inside a window — the list the
 * HR letters go out from ("you reach 5 years on 12 June; your vacation goes to
 * 6%"). Anniversary arithmetic happens in PostgreSQL so the report and this
 * function can never disagree about a month-end hire date.
 */
export async function milestonesReachedInPeriod(
  orgId: string,
  from: string,
  to: string,
): Promise<ServiceMilestone[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select er.party_id as employee_party_id, p.display_name as employee_name,
           er.hired_on, t.after_months, t.accrual_value, t.eligible,
           t.plan_id, pl.name as plan_name, t.component_id, c.name as component_name,
           (er.hired_on + make_interval(months => t.after_months))::date as milestone_date
      from entitlement_service_tiers t
      join employee_roles er on er.org_id = t.org_id and er.hired_on is not null and er.is_active
      join parties p on p.id = er.party_id and p.org_id = er.org_id
      left join entitlement_plans pl on pl.id = t.plan_id and pl.org_id = t.org_id
      left join pay_components c on c.id = t.component_id and c.org_id = t.org_id
     where t.org_id = ${orgId} and t.is_active
       and (er.terminated_on is null or er.terminated_on >= ${from})
       and (er.hired_on + make_interval(months => t.after_months))::date between ${from} and ${to}
     order by milestone_date, p.display_name
  `));
  return rows.rows.map((row) => ({
    employeePartyId: String(row.employee_party_id),
    employeeName: String(row.employee_name),
    hiredOn: String(row.hired_on).slice(0, 10),
    afterMonths: Number(row.after_months),
    milestoneDate: String(row.milestone_date).slice(0, 10),
    planId: row.plan_id != null ? String(row.plan_id) : null,
    planName: row.plan_name != null ? String(row.plan_name) : null,
    accrualValue: row.accrual_value != null ? String(row.accrual_value) : null,
    componentId: row.component_id != null ? String(row.component_id) : null,
    componentName: row.component_name != null ? String(row.component_name) : null,
    eligible: row.eligible == null ? null : row.eligible === true,
  }));
}
