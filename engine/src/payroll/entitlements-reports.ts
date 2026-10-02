import { serviceCreditMilestoneDate, type ServiceCreditBaseline } from "./service-credit.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { cmp, roundMoney } from "../money/money.ts";
import { resolvePlanLimit } from "./entitlements-db.ts";
import {
  type EntitlementLimitScope,
  type EntitlementUnit,
} from "./entitlements-types.ts";

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
  employmentId: string;
  employerSubsidiaryId: string;
  employeePartyId: string;
  employeeName: string;
  hiredOn: string | null;
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
 * 6%"). The same credited-service convention used by payroll determines
 * the date without changing the original hire evidence.
 */
export async function milestonesReachedInPeriod(
  orgId: string,
  from: string,
  to: string,
): Promise<ServiceMilestone[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select e.id as employment_id, e.employer_subsidiary_id, t.id as tier_id, t.employer_subsidiary_id as tier_employer,
           e.worker_party_id as employee_party_id, p.display_name as employee_name, e.service_start as hired_on,
           t.after_months, t.accrual_value, t.eligible, t.plan_id, pl.name as plan_name,
           t.component_id, c.name as component_name, t.effective_from as tier_from, t.effective_to as tier_to,
           sc.id as credit_id, sc.convention, sc.as_of_date, sc.credited_days::text, sc.credited_months,
           sc.effective_from as credit_from, sc.effective_to as credit_to
      from entitlement_service_tiers t
      join worker_employments e on e.org_id = t.org_id and (
        exists (select 1 from payroll_vacation_terms vt where vt.org_id=e.org_id and vt.employment_id=e.id
          and vt.effective_from<=${to}::date and (vt.effective_to is null or vt.effective_to>=${from}::date))
        or exists (select 1 from employee_payroll_profiles prof where prof.org_id=e.org_id and prof.employment_id=e.id and prof.is_active)
      )
      join parties p on p.id = e.worker_party_id and p.org_id = e.org_id
      left join payroll_service_credits sc on sc.org_id = e.org_id and sc.employment_id = e.id
        and sc.effective_from <= ${to}::date and (sc.effective_to is null or sc.effective_to >= ${from}::date)
      left join entitlement_plans pl on pl.id = t.plan_id and pl.org_id = t.org_id
      left join pay_components c on c.id = t.component_id and c.org_id = t.org_id
     where t.org_id = ${orgId} and t.is_active and t.effective_from <= ${to}::date
       and (t.employer_subsidiary_id is null or t.employer_subsidiary_id=e.employer_subsidiary_id)
       and (t.effective_to is null or t.effective_to >= ${from}::date)
  `);
  const result: ServiceMilestone[] = [];
  const seen = new Set<string>();
  const effectiveAt = (date: string, start: unknown, end: unknown): boolean =>
    (start == null || date >= String(start).slice(0, 10)) && (end == null || date <= String(end).slice(0, 10));
  for (const row of rows.rows) {
    const baselines: ServiceCreditBaseline[] = [];
    if (row.credit_id) baselines.push({ id: String(row.credit_id), convention: row.convention as ServiceCreditBaseline['convention'],
      asOfDate: String(row.as_of_date).slice(0, 10), creditedDays: row.credited_days == null ? null : String(row.credited_days),
      creditedMonths: row.credited_months == null ? null : Number(row.credited_months), sourceSnapshot: {} });
    if (row.hired_on) baselines.push({ id: null, convention: 'calendar_months', asOfDate: String(row.hired_on).slice(0, 10), creditedDays: null, creditedMonths: 0, sourceSnapshot: {} });
    for (const baseline of baselines) {
      const milestoneDate = serviceCreditMilestoneDate(baseline, Number(row.after_months));
      if (milestoneDate < from || milestoneDate > to || !effectiveAt(milestoneDate, row.tier_from, row.tier_to)) continue;
      if (baseline.id && !effectiveAt(milestoneDate, row.credit_from, row.credit_to)) continue;
      if (!baseline.id && rows.rows.some((candidate) => candidate.employment_id === row.employment_id && candidate.credit_id && effectiveAt(milestoneDate, candidate.credit_from, candidate.credit_to))) continue;
      // A scoped ladder replaces the organization default only while that ladder is effective.
      if (row.tier_employer == null && rows.rows.some((candidate) => candidate.employment_id === row.employment_id
        && candidate.tier_employer === row.employer_subsidiary_id && candidate.plan_id === row.plan_id && candidate.component_id === row.component_id
        && effectiveAt(milestoneDate, candidate.tier_from, candidate.tier_to))) continue;
      const key = `${String(row.employment_id)}:${String(row.tier_id)}:${milestoneDate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ employmentId: String(row.employment_id), employerSubsidiaryId: String(row.employer_subsidiary_id),
        employeePartyId: String(row.employee_party_id), employeeName: String(row.employee_name),
        hiredOn: row.hired_on ? String(row.hired_on).slice(0, 10) : null, afterMonths: Number(row.after_months), milestoneDate,
        planId: row.plan_id != null ? String(row.plan_id) : null, planName: row.plan_name != null ? String(row.plan_name) : null,
        accrualValue: row.accrual_value != null ? String(row.accrual_value) : null,
        componentId: row.component_id != null ? String(row.component_id) : null, componentName: row.component_name != null ? String(row.component_name) : null,
        eligible: row.eligible == null ? null : row.eligible === true });
    }
  }
  return result.sort((a, b) => a.milestoneDate.localeCompare(b.milestoneDate) || a.employeeName.localeCompare(b.employeeName));
}
