import { sql } from 'drizzle-orm';
import { db, withOrgTransaction, type SqlExecutor } from '../platform/db.ts';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts';
import { PayrollError } from './error.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from './scope.ts';

class PayrollProfileEmploymentError extends PayrollError {
  readonly status = 422;
}

/** Validate the stable employment identity; effective coverage remains a dated HRM policy. */
export async function payrollProfileEmployment(
  exec: SqlExecutor,
  orgId: string,
  employeePartyId: string,
  employerId: string | null,
  linkedId: string | null,
): Promise<string | null> {
  const rows = (await exec.execute<{ id: string; employer_subsidiary_id: string }>(sql`
    select id, employer_subsidiary_id from worker_employments
    where org_id=${orgId} and worker_party_id=${employeePartyId}
    order by id for share`)).rows;
  if (linkedId !== null) {
    const linked = rows.find(row => row.id === linkedId);
    if (!linked || linked.employer_subsidiary_id !== employerId) {
      throw new PayrollProfileEmploymentError('The payroll employment does not belong to this employee and legal employer — review the employee employment record before saving payroll settings');
    }
    return linkedId;
  }
  // An unlinked profile can be configured before HRM is complete, but cannot calculate.
  // Several employment episodes require an explicit choice through the link import.
  return rows.length === 1 && rows[0]!.employer_subsidiary_id === employerId ? rows[0]!.id : null;
}

/** Fill an explicitly reviewed missing profile link without moving posted payroll history. */
export async function linkPayrollProfileEmployment(input: {
  orgId: string; actorId: string; employeePartyId: string; employmentId: string;
  reason: string; dryRun: boolean; allowedSubsidiaryIds: PayrollSubsidiaryScope;
}): Promise<{ changed: boolean }> {
  if (![input.employeePartyId, input.employmentId].every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) {
    throw new PayrollProfileEmploymentError('Use the employee ID and employment ID exported from the native employee records');
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new PayrollProfileEmploymentError('Provide a reason or source reference of 1–500 characters for the employment link');
  if (typeof input.dryRun !== 'boolean') throw new PayrollProfileEmploymentError('Specify whether the employment link is a preview or an apply');
  if (input.allowedSubsidiaryIds === undefined) throw new PayrollProfileEmploymentError('Employment linking requires an explicit legal-entity scope');
  return withOrgTransaction(input.orgId, async () => {
    if (!await actorHasPermission(db, input.orgId, input.actorId, 'payroll.manage')) throw new PayrollProfileEmploymentError('Payroll manage permission is required to link an employment');
    if (!await lockAndCheckOrgFeature(db, input.orgId, 'payroll')) throw new PayrollProfileEmploymentError('Enable Payroll in Company Settings → Features before linking employments');
    const employee = (await db.execute<{ subsidiary_id: string | null }>(sql`
      select p.subsidiary_id from parties p where p.org_id=${input.orgId} and p.id=${input.employeePartyId}
      ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
      for no key update`)).rows[0];
    if (!employee) throw new PayrollProfileEmploymentError('The employee is not available in your legal entity — review the employee ID');
    const before = (await db.execute<{ id: string; employment_id: string | null }>(sql`
      select id, employment_id from employee_payroll_profiles
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} for update`)).rows[0];
    if (!before) throw new PayrollProfileEmploymentError('No payroll profile is available for this employee in your legal entity — create the payroll profile from Employees first');
    await payrollProfileEmployment(db, input.orgId, input.employeePartyId, employee.subsidiary_id, input.employmentId);
    if (before.employment_id !== null && before.employment_id !== input.employmentId) {
      throw new PayrollProfileEmploymentError('This payroll profile is already linked to a different employment — review its payroll and employment history; this import only fills missing links');
    }
    if (before.employment_id === input.employmentId) return { changed: false };
    if (input.dryRun) return { changed: true };
    const updated = (await db.execute(sql`update employee_payroll_profiles
      set employment_id=${input.employmentId}, updated_by=${input.actorId},
        updated_at=greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      where org_id=${input.orgId} and id=${before.id} and employment_id is null returning id`)).rows;
    if (updated.length !== 1) throw new PayrollProfileEmploymentError('The payroll employment link changed — preview the import again');
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values (${input.orgId},'employee_payroll_profiles',${before.id},'update',
        ${JSON.stringify({ before: { employmentId: null }, after: { employmentId: input.employmentId }, employeePartyId: input.employeePartyId, reason })}::jsonb,${input.actorId})`);
    return { changed: true };
  });
}
