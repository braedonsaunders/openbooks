import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { businessToday } from "./business-date.ts";
import { cmp, roundMoney } from "./money.ts";
import { resolvePlanLimit } from "./payroll-entitlements-db.ts";
import {
  type EntitlementLimitScope,
  type EntitlementUnit,
} from "./payroll-entitlements-types.ts";

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
