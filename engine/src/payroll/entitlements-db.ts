import { committedEntitlementMovementSql } from "./entitlement-movement-scope.ts";
import { PayrollError } from "./error.ts";
import { resolveEmploymentServiceCredit } from "./service-credit.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { cmp, div, isZero, mulDecimal, roundMoney } from "../money/money.ts";
import { pickPlanLimit } from "./entitlements-limits.ts";
import { resolveEntitlementWage } from "./run-entitlement-valuation.ts";
import {
  type ResolvedServiceTiers,
  resolveServiceTiersFrom,
  type ServiceTierRow,
} from "./entitlements-service-tiers.ts";
import {
  STAT_HOLIDAY_ALTERNATE_PLAN_SYSTEM_KEY,
  type EntitlementAccrualMethod,
  type EntitlementCapBehavior,
  type EntitlementLimitRow,
  type EntitlementPlan,
  type EntitlementPlanLimit,
  type EntitlementScopeKeys,
  VACATION_PLAN_SYSTEM_KEY,
} from "./entitlements-types.ts";

/* ------------------------------------------------------------------ */
/* Database adapters                                                   */
/* ------------------------------------------------------------------ */

export type Executor = Pick<typeof db, "execute">;

function planFromRow(row: Record<string, unknown>): EntitlementPlan {
  // Engine bindings are a closed set: a value the code does not know is
  // unmapped (never passed through as a string the engine would then fail to
  // match), so a migration that adds a binding without its code half leaves
  // the plan inert rather than half-bound.
  const systemKey =
    row.system_key === VACATION_PLAN_SYSTEM_KEY
      ? VACATION_PLAN_SYSTEM_KEY
      : row.system_key === STAT_HOLIDAY_ALTERNATE_PLAN_SYSTEM_KEY
        ? STAT_HOLIDAY_ALTERNATE_PLAN_SYSTEM_KEY
        : null;
  return {
    id: String(row.id),
    code: String(row.code),
    systemKey,
    name: String(row.name),
    unit: row.unit === "hours" ? "hours" : "money",
    direction: row.direction === "owe" ? "owe" : "accrue",
    accrualMethod: String(row.accrual_method) as EntitlementAccrualMethod,
    accrualValue: row.accrual_value != null ? String(row.accrual_value) : null,
    accrualComponentId: row.accrual_component_id != null ? String(row.accrual_component_id) : null,
    payoutComponentId: row.payout_component_id != null ? String(row.payout_component_id) : null,
    depositComponentId: row.deposit_component_id != null ? String(row.deposit_component_id) : null,
    allowNegativeBalance: row.allow_negative_balance === true,
    liabilityAccountId: row.liability_account_id != null ? String(row.liability_account_id) : null,
    capBehavior: String(row.cap_behavior) as EntitlementCapBehavior,
  };
}

/** Active plans for an org, in code order. */
export async function entitlementPlans(
  orgId: string,
  executor: Executor = db,
): Promise<EntitlementPlan[]> {
  const r = await executor.execute<Record<string, unknown>>(
    sql`
    select * from entitlement_plans
     where org_id = ${orgId} and is_active
     order by code
  `,
    "objects",
  );
  return r.map(planFromRow);
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
export function vacationPlanOf(plans: readonly EntitlementPlan[]): EntitlementPlan | null {
  return plans.find((plan) => plan.systemKey === VACATION_PLAN_SYSTEM_KEY) ?? null;
}

/**
 * The org's statutory alternate-day-off bank (0413), resolved on its ENGINE
 * BINDING like the vacation plan above — never on the operator-typed code.
 */
export function alternateDayPlanOf(plans: readonly EntitlementPlan[]): EntitlementPlan | null {
  return plans.find((plan) => plan.systemKey === STAT_HOLIDAY_ALTERNATE_PLAN_SYSTEM_KEY) ?? null;
}

async function entitlementEmployment(
  executor: Executor,
  orgId: string,
  employeePartyId: string,
  onDate: string,
  employmentId?: string,
) {
  const employments = await executor.execute<{
    id: string;
    service_start: string | null;
    employer_subsidiary_id: string;
  }>(
    sql`
    select e.id, e.service_start, e.employer_subsidiary_id from worker_employments e
    where e.org_id = ${orgId} and e.worker_party_id = ${employeePartyId}
      and ${
        employmentId
          ? sql`e.id = ${employmentId}`
          : sql`e.id in (
        select employment_id from payroll_vacation_terms where org_id = ${orgId}
          and effective_from <= ${onDate}::date and (effective_to is null or effective_to >= ${onDate}::date)
        union select employment_id from employee_payroll_profiles where org_id = ${orgId} and employee_party_id = ${employeePartyId} and is_active
      )`
      }
  `,
    "objects",
  );
  if (employments.length > 1)
    throw new PayrollError(
      "Multiple employments resolve for this employee; select the specific employment before resolving service entitlements.",
    );
  if (employmentId && employments.length === 0)
    throw new PayrollError(
      "Select an employment belonging to this employee and organization before resolving entitlements.",
    );
  return employments[0];
}

/** The scope keys an employee competes on — the wage resolver's inputs. */
export async function employeeScope(
  executor: Executor,
  orgId: string,
  employeePartyId: string,
  context?: { onDate: string; employmentId?: string },
): Promise<EntitlementScopeKeys> {
  const r = await executor.execute<{
    job_title: string | null;
    trade_id: string | null;
    department_id: string | null;
    subsidiary_id: string | null;
  }>(
    sql`
    select er.job_title, er.trade_id, er.department_id, p.subsidiary_id
      from parties p
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
     where p.org_id = ${orgId} and p.id = ${employeePartyId}
  `,
    "objects",
  );
  const row = r[0];
  const employment = await entitlementEmployment(
    executor,
    orgId,
    employeePartyId,
    context?.onDate ?? (await businessToday(orgId)),
    context?.employmentId,
  );
  return {
    employeePartyId,
    jobTitle: row?.job_title ?? null,
    tradeId: row?.trade_id ?? null,
    departmentId: row?.department_id ?? null,
    subsidiaryId: employment?.employer_subsidiary_id ?? row?.subsidiary_id ?? null,
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
  employmentId?: string,
): Promise<EntitlementPlanLimit | null> {
  const scope =
    knownScope ?? (await employeeScope(executor, orgId, employeePartyId, { onDate, employmentId }));
  const r = await executor.execute<Record<string, unknown>>(
    sql`
    select id, plan_id, employee_party_id, job_title, trade_id, department_id, subsidiary_id,
           max_balance, notify_balance, effective_from, effective_to, is_active
      from entitlement_plan_limits
     where org_id = ${orgId} and plan_id = ${planId} and is_active
       and effective_from <= ${onDate}
       and (effective_to is null or effective_to >= ${onDate})
  `,
    "objects",
  );
  const rows: EntitlementLimitRow[] = r.map((row) => ({
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
 * The employment credited-service baseline and effective schedule determine
 * monetary plan rates, separate annual day allowances, and component eligibility.
 */
export async function resolveServiceTier(
  executor: Executor,
  orgId: string,
  employeePartyId: string,
  onDate: string,
  employmentId?: string,
): Promise<ResolvedServiceTiers> {
  const employment = await entitlementEmployment(
    executor,
    orgId,
    employeePartyId,
    onDate,
    employmentId,
  );
  const hiredOn = employment?.service_start ? String(employment.service_start).slice(0, 10) : null;
  const service = employment
    ? await resolveEmploymentServiceCredit(executor, {
        orgId,
        employmentId: employment.id,
        asOf: onDate,
      })
    : null;
  const tiers = await executor.execute<Record<string, unknown>>(
    sql`
    select id, plan_id, component_id, after_months, accrual_value, eligible, is_active, annual_days, employer_subsidiary_id
      from entitlement_service_tiers
     where org_id = ${orgId} and is_active and effective_from <= ${onDate}::date
       and (effective_to is null or effective_to >= ${onDate}::date)
       and (employer_subsidiary_id is null or employer_subsidiary_id = ${employment?.employer_subsidiary_id ?? null})
     order by after_months
  `,
    "objects",
  );
  const rows: ServiceTierRow[] = tiers.map((row) => ({
    id: String(row.id),
    planId: row.plan_id != null ? String(row.plan_id) : null,
    componentId: row.component_id != null ? String(row.component_id) : null,
    afterMonths: Number(row.after_months),
    accrualValue: row.accrual_value != null ? String(row.accrual_value) : null,
    employerSubsidiaryId:
      row.employer_subsidiary_id == null ? null : String(row.employer_subsidiary_id),
    annualDays: row.annual_days != null ? String(row.annual_days) : null,
    eligible: row.eligible == null ? null : row.eligible === true || row.eligible === "true",
    isActive: row.is_active !== false,
  }));
  if (rows.length > 0 && service == null)
    throw new PayrollError(
      "Service-based entitlements need credited service or a documented employment service start; record the employee service baseline before calculating payroll.",
    );
  const months = service?.completedMonths ?? null;
  return resolveServiceTiersFrom(rows, months, hiredOn, employment?.employer_subsidiary_id);
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
 * Balances include independent movements and committed pay runs. Calculated
 * movements remain previews until commit. A caller's executor keeps the read
 * in its transaction; an excluded run is omitted from the committed basis.
 */
export async function entitlementBalances(
  orgId: string,
  employeePartyId: string,
  asOf?: string,
  opts: {
    executor?: Executor;
    /** Employment whose legal employer owns the effective bank limit. */
    employmentId?: string;
    /** Ignore this run's own movements — required from inside a calculation. */
    excludeRunDocumentId?: string | null;
    /** Plans to report on; loaded from the org when omitted. */
    plans?: readonly EntitlementPlan[];
    /** Pay-run currency to use when valuing an hours bank for a cheque. */
    payCurrency?: string;
    /** Lock the selected wage row when called during calculation. */
    lockWage?: boolean;
  } = {},
): Promise<EntitlementBalance[]> {
  const executor = opts.executor ?? db;
  const excludeRunDocumentId = opts.excludeRunDocumentId ?? null;
  const plans = opts.plans ?? (await entitlementPlans(orgId, executor));
  if (plans.length === 0) return [];
  const onDate = asOf ?? (await businessToday(orgId));
  const sums = await executor.execute<{
    plan_id: string;
    balance: string;
    last_movement: string | null;
  }>(
    sql`
    select l.plan_id, sum(l.amount) as balance, max(l.movement_date) as last_movement
      from entitlement_ledger l
      left join pay_runs r on r.org_id = l.org_id and r.document_id = l.pay_run_document_id
     where l.org_id = ${orgId} and l.employee_party_id = ${employeePartyId}
       and l.movement_date <= ${onDate}
       and ${committedEntitlementMovementSql(sql`l.pay_run_document_id`, sql`r.run_status`)}
       and (${excludeRunDocumentId}::uuid is null
            or l.pay_run_document_id is distinct from ${excludeRunDocumentId}::uuid)
     group by l.plan_id
  `,
    "objects",
  );
  const byPlan = new Map(sums.map((row) => [row.plan_id, row]));

  // One transaction-bound wage lookup serves every plan's hours view.
  const resolved = await resolveEntitlementWage(
    executor,
    orgId,
    employeePartyId,
    onDate,
    opts.payCurrency,
    opts.lockWage ?? false,
  );
  const wage = resolved && cmp(resolved.wage, "0") > 0 ? resolved.wage : null;
  const scope = await employeeScope(executor, orgId, employeePartyId, {
    onDate,
    employmentId: opts.employmentId,
  });

  const balances: EntitlementBalance[] = [];
  for (const plan of plans) {
    const row = byPlan.get(plan.id);
    const balance = row ? roundMoney(String(row.balance), 4) : "0.0000";
    const limit = await resolvePlanLimit(executor, orgId, plan.id, employeePartyId, onDate, scope);
    const balanceMoney =
      plan.unit === "money" ? balance : wage ? roundMoney(mulDecimal(balance, wage), 2) : null;
    const balanceHours =
      plan.unit === "hours"
        ? balance
        : // `wage ?` does not screen a zero wage — the string "0" is truthy — and
          // divRate then rejected it as an invalid FX rate. Money cannot be
          // expressed as hours at a zero wage, so report no hours instead.
          wage && !isZero(String(wage))
          ? div(balance, String(wage))
          : null;
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
 * Committed balance for a calculation, using its transaction-bound executor
 * and omitting the specified run. Editable calculations never consume another
 * run's preview movements as available funds or settled withdrawals.
 */
export async function planBalanceExcludingRun(
  executor: Executor,
  orgId: string,
  planId: string,
  employeePartyId: string,
  onDate: string,
  excludeRunDocumentId: string | null,
): Promise<string> {
  const r = await executor.execute<{ balance: string }>(
    sql`
    select coalesce(sum(l.amount), 0) as balance
      from entitlement_ledger l
      left join pay_runs r on r.org_id = l.org_id and r.document_id = l.pay_run_document_id
     where l.org_id = ${orgId} and l.plan_id = ${planId}
       and l.employee_party_id = ${employeePartyId}
       and l.movement_date <= ${onDate}
       and ${committedEntitlementMovementSql(sql`l.pay_run_document_id`, sql`r.run_status`)}
       and (${excludeRunDocumentId}::uuid is null
            or l.pay_run_document_id is distinct from ${excludeRunDocumentId}::uuid)
  `,
    "objects",
  );
  return roundMoney(String(r[0]?.balance ?? "0"), 4);
}
