import { sql } from 'drizzle-orm';
import { db, withOrgTransaction, inExecutorTransaction, type SqlExecutor } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts';
import { PayrollError } from './error.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from './scope.ts';

class WorkerCompAssignmentError extends PayrollError {
  readonly status = 422;
}

/** The employee drawer and bulk import share one audited classification writer. */
export async function assignEmployeeWorkerCompGroup(input: {
  orgId: string; actorId: string; employeePartyId: string;
  groupId: string | null; expectedGroupId: string | null; reason: string;
  dryRun: boolean; allowedSubsidiaryIds: PayrollSubsidiaryScope;
}, executor?: SqlExecutor): Promise<{ changed: boolean }> {
  if (!isUuid(input.employeePartyId)
    || (input.groupId !== null && !isUuid(input.groupId))
    || (input.expectedGroupId !== null && !isUuid(input.expectedGroupId))) {
    throw new WorkerCompAssignmentError('Use the employee and worker-compensation group IDs exported from the native records');
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new WorkerCompAssignmentError('Provide a reason or source reference of 1–500 characters for the worker-compensation assignment');
  if (typeof input.dryRun !== 'boolean') throw new WorkerCompAssignmentError('Specify whether the worker-compensation assignment is a preview or an apply');
  if (input.allowedSubsidiaryIds === undefined) throw new WorkerCompAssignmentError('Worker-compensation assignments require an explicit legal-entity scope');
  const apply = async (tx: SqlExecutor) => {
    if (!await actorHasPermission(tx, input.orgId, input.actorId, 'parties.manage')) {
      throw new WorkerCompAssignmentError('Employee manage permission is required to assign a worker-compensation group');
    }
    const authority = await lockActorCommandAuthority(tx, input.orgId, input.actorId, null, 'parties.manage');
    if (!await lockAndCheckOrgFeature(tx, input.orgId, 'payroll')) {
      throw new WorkerCompAssignmentError('Enable Payroll in Company Settings → Features before assigning worker-compensation groups');
    }
    const employee = (await tx.execute<{ id: string }>(sql`
      select p.id from parties p where p.org_id=${input.orgId} and p.id=${input.employeePartyId}
      ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
      ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, authority)} for update`)).rows[0];
    if (!employee) throw new WorkerCompAssignmentError('The employee is not available in your legal entity — review the employee ID');
    const before = (await tx.execute<{ id: string; worker_comp_group_id: string | null }>(sql`
      select id, worker_comp_group_id from employee_roles
      where org_id=${input.orgId} and party_id=${input.employeePartyId} and is_active for update`)).rows[0];
    if (!before) throw new WorkerCompAssignmentError('No active employee role is available — review the employee record before assigning worker compensation');
    if (input.groupId !== null && !(await tx.execute(sql`
      select id from worker_comp_groups where org_id=${input.orgId} and id=${input.groupId} and is_active for share`)).rows.length) {
      throw new WorkerCompAssignmentError('The worker-compensation group is unavailable in this organization — choose an active group in Company Settings');
    }
    if (before.worker_comp_group_id === input.groupId) return { changed: false };
    if (before.worker_comp_group_id !== input.expectedGroupId) {
      throw new WorkerCompAssignmentError('The employee worker-compensation assignment changed — export and review the current group before applying');
    }
    if (input.dryRun) return { changed: true };
    const updated = (await tx.execute(sql`update employee_roles
      set worker_comp_group_id=${input.groupId}, updated_by=${input.actorId},
        updated_at=greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      where org_id=${input.orgId} and id=${before.id}
        and worker_comp_group_id is not distinct from ${input.expectedGroupId}::uuid returning id`)).rows;
    if (updated.length !== 1) throw new WorkerCompAssignmentError('The employee worker-compensation assignment changed — preview the import again');
    const party = (await tx.execute(sql`update parties set updated_by=${input.actorId},
      updated_at=greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      where org_id=${input.orgId} and id=${input.employeePartyId} returning id`)).rows;
    if (party.length !== 1) throw new WorkerCompAssignmentError('The employee is no longer available — reload the employee record');
    await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values (${input.orgId},'employee_roles',${before.id},'update',
        ${JSON.stringify({ before: { workerCompGroupId: before.worker_comp_group_id }, after: { workerCompGroupId: input.groupId }, employeePartyId: input.employeePartyId, reason })}::jsonb,${input.actorId})`);
    return { changed: true };
  };
  return executor ? inExecutorTransaction(executor, apply) : withOrgTransaction(input.orgId, () => apply(db));
}
