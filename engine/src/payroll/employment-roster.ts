import { takeEmployeeConfigurationFence } from "./fences.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { sql, type SQL } from "drizzle-orm";

interface EmploymentRosterColumns {
  org: SQL;
  employee: SQL;
  employment: SQL;
  employer: SQL;
  hiredOn: SQL;
  terminatedOn: SQL;
  periodStart: SQL;
  periodEnd: SQL;
}

/** Latest role dates describe an episode, not the worker's entire history. */
export function roleEmploymentOverlapsPeriod(c: Pick<EmploymentRosterColumns, "hiredOn" | "terminatedOn" | "periodStart" | "periodEnd">): SQL {
  return sql`((${c.hiredOn} is null or ${c.hiredOn} <= ${c.periodEnd}::date)
    and (${c.terminatedOn} is null or ${c.terminatedOn} >= ${c.periodStart}::date))`;
}

/** Admit only recorded, effective coverage of the profile's exact legal employment. */
export function historicalEmploymentOverlapsPeriod(c: EmploymentRosterColumns): SQL {
  return sql`exists (
    select 1 from worker_employments roster_employment
    join worker_employment_versions roster_version
      on roster_version.org_id = roster_employment.org_id
     and roster_version.employment_id = roster_employment.id
    where roster_employment.org_id = ${c.org}
      and roster_employment.id = ${c.employment}
      and roster_employment.worker_party_id = ${c.employee}
      and roster_employment.employer_subsidiary_id = ${c.employer}
      and roster_version.recorded_until is null
      and roster_version.status in ('active', 'on_leave')
      and roster_version.effective_from <= ${c.periodEnd}::date
      and (roster_version.effective_to is null or roster_version.effective_to > ${c.periodStart}::date))`;
}

export function payrollEmploymentOverlapsPeriod(c: EmploymentRosterColumns): SQL {
  return sql`(${roleEmploymentOverlapsPeriod(c)} or ${historicalEmploymentOverlapsPeriod(c)})`;
}

/** A previous active window cannot establish that episode's hire or release date. */
export function payrollEpisodeDate(c: EmploymentRosterColumns, date: SQL): SQL {
  return sql`case when ${roleEmploymentOverlapsPeriod(c)} then ${date} else null end`;
}

export interface HistoricalEmploymentRosterSource {
  employeePartyId: string;
  employmentId: string;
  versionNo: number;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  recordedAt: string;
}

/** Read every historical admission, including employees absent from the calculated stubs. */
export async function historicalEmploymentRosterSource(
  tx: Pick<SqlExecutor, "execute">, orgId: string, documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<HistoricalEmploymentRosterSource[]> {
  const columns = {
    org: sql`prof.org_id`, employee: sql`p.id`, employment: sql`prof.employment_id`,
    employer: sql`p.subsidiary_id`, hiredOn: sql`er.hired_on`, terminatedOn: sql`er.terminated_on`,
    periodStart: sql`r.period_start`, periodEnd: sql`r.period_end`,
  };
  return (await tx.execute<HistoricalEmploymentRosterSource & Record<string, unknown>>(sql`
    select distinct p.id::text as "employeePartyId", e.id::text as "employmentId",
           v.version_no as "versionNo", v.status,
           v.effective_from::text as "effectiveFrom", v.effective_to::text as "effectiveTo",
           to_char(v.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt"
      from pay_runs r
      join documents d on d.org_id = r.org_id and d.id = r.document_id
      join employee_payroll_profiles prof on prof.org_id = r.org_id and prof.pay_schedule_id = r.pay_schedule_id
      join parties p on p.org_id = prof.org_id and p.id = prof.employee_party_id
      left join employee_roles er on er.org_id = p.org_id and er.party_id = p.id
      join worker_employments e on e.org_id = prof.org_id and e.id = prof.employment_id
        and e.worker_party_id = p.id and e.employer_subsidiary_id = p.subsidiary_id
      join worker_employment_versions v on v.org_id = e.org_id and v.employment_id = e.id
     where r.org_id = ${orgId} and r.document_id = ${documentId} and prof.is_active
       and not ${roleEmploymentOverlapsPeriod(columns)}
       and v.recorded_until is null and v.status in ('active', 'on_leave')
       and v.effective_from <= r.period_end
       and (v.effective_to is null or v.effective_to > r.period_start)
       and (d.subsidiary_id is null or d.subsidiary_id = p.subsidiary_id)
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
       and not exists (select 1 from pay_run_adjustments a where a.org_id = r.org_id
         and a.pay_run_document_id = r.document_id and a.employee_party_id = p.id and a.adjustment_type = 'exclude')
     order by "employeePartyId", "employmentId", "versionNo"
  `)).rows;
}

/** Fence possible admissions before yearly payroll locks, including previously excluded workers. */
export async function lockPayrollEmploymentRoster(
  tx: Pick<SqlExecutor, "execute">, orgId: string, documentId: string,
): Promise<void> {
  const employees = (await tx.execute<{ employee_party_id: string }>(sql`
    select prof.employee_party_id from employee_payroll_profiles prof
    join pay_runs r on r.org_id = prof.org_id and r.pay_schedule_id = prof.pay_schedule_id
    where r.org_id = ${orgId} and r.document_id = ${documentId} and prof.is_active
    union select employee_party_id from pay_stubs
    where org_id = ${orgId} and pay_run_document_id = ${documentId}
    order by employee_party_id
  `)).rows;
  for (const employee of employees) {
    await takeEmployeeConfigurationFence(tx, orgId, employee.employee_party_id);
  }
}
