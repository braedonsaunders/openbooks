import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { businessToday } from "./business-date.ts";
import { cmp, div, isZero, mulDecimal, roundMoney } from "./money.ts";
import { pickPlanLimit } from "./payroll-entitlements-limits.ts";
import {
  monthsOfService,
  type ResolvedServiceTiers,
  resolveServiceTiersFrom,
  type ServiceTierRow,
} from "./payroll-entitlements-service-tiers.ts";
import {
  type EntitlementAccrualMethod,
  type EntitlementCapBehavior,
  type EntitlementLimitRow,
  type EntitlementPlan,
  type EntitlementPlanLimit,
  type EntitlementScopeKeys,
  VACATION_PLAN_SYSTEM_KEY,
} from "./payroll-entitlements-types.ts";

/* ------------------------------------------------------------------ */
/* Database adapters                                                   */
/* ------------------------------------------------------------------ */

export type Executor = Pick<typeof db, "execute">;

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
export async function employeeScope(
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
