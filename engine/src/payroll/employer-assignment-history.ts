import { sql } from 'drizzle-orm';
import { db, inExecutorTransaction, withOrgTransaction, type SqlExecutor } from '../platform/db.ts';
import { isIsoCalendarDate } from '../platform/civil-date.ts';
import { businessTodayInTx } from '../platform/business-date.ts';
import { isUuid } from '../platform/uuid.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { lockScopeRows } from '../organization/subsidiary-scope.ts';
import { employeeTaxYearFenceKey, takeEmployeeTaxYearFences } from './fences.ts';
import { requirePayrollFeature } from './feature-gate.ts';
import { PayrollError } from './error.ts';
import type { PayrollSubsidiaryScope } from './scope.ts';

export type EmployerAssignmentKind = 'filing_account' | 'worker_comp';
export interface EmployerAssignmentSource {
  id: string; employeePartyId: string; subsidiaryId: string; kind: EmployerAssignmentKind;
  effectiveFrom: string; effectiveTo: string; filingAccountId: string | null;
  workerCompGroupId: string | null; createdAt: string; sourceReference: string;
}
type Reader = Pick<SqlExecutor, 'execute'>;
async function available(tx: Reader): Promise<boolean> {
  return (await tx.execute<{ available: boolean }>(sql`select to_regclass('public.payroll_employee_employer_assignments') is not null as available`)).rows[0]?.available === true;
}

/** Read explicit dated evidence; pre-installation databases cannot contain these assignments. */
export async function employeeEmployerAssignmentHistory(tx: Reader, input: {
  orgId: string; payDate: string; employeePartyIds: readonly string[];
}): Promise<EmployerAssignmentSource[]> {
  if (!input.employeePartyIds.length || !await available(tx)) return [];
  return (await tx.execute<EmployerAssignmentSource & Record<string, unknown>>(sql`select id::text, employee_party_id::text as "employeePartyId",
    subsidiary_id::text as "subsidiaryId", assignment_kind as kind, effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
    filing_account_id::text as "filingAccountId",worker_comp_group_id::text as "workerCompGroupId",
    to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",source_reference as "sourceReference"
    from payroll_employee_employer_assignments where org_id=${input.orgId}
      and employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(input.employeePartyIds)}::jsonb)::uuid)
      and ${input.payDate}::date between effective_from and effective_to
    order by employee_party_id,assignment_kind,id`)).rows;
}

/** Caller owns the employee/year fences before locking these profile revision rows. */
export async function lockEmployerAssignmentProfiles(tx: Reader, orgId: string, employees: readonly string[]): Promise<void> {
  if (!employees.length || !await available(tx)) return;
  await tx.execute(sql`select id from employee_payroll_profiles where org_id=${orgId}
    and employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(employees)}::jsonb)::uuid)
    order by employee_party_id for share`);
}

/** Apply historical account metadata before the employee jurisdiction is resolved. */
export async function applyEmployeeEmployerAssignmentHistory(tx: Reader, orgId: string, payDate: string,
  employees: Record<string, string | null>[]): Promise<void> {
  const rows = await employeeEmployerAssignmentHistory(tx, { orgId, payDate, employeePartyIds: employees.map(e => e.party_id!) });
  for (const employee of employees) {
    const assignments = rows.filter(r => r.employeePartyId === employee.party_id);
    const kinds = new Set<string>();
    for (const assignment of assignments) {
      if (kinds.has(assignment.kind) || assignment.subsidiaryId !== employee.employee_subsidiary_id) {
        throw new PayrollError(`${employee.display_name}: dated employer assignments overlap or name another legal employer — review the recorded assignment before calculating.`);
      }
      kinds.add(assignment.kind);
      if (assignment.kind === 'worker_comp') {
        employee.historical_worker_comp_group_id = assignment.workerCompGroupId;
      } else {
        const account = (await tx.execute<{ country: string; account_number: string }>(sql`select country,account_number
          from payroll_filing_accounts where org_id=${orgId} and id=${assignment.filingAccountId} for share`)).rows[0];
        if (!account || account.country !== employee.country) throw new PayrollError(`${employee.display_name}: the dated filing account does not match the employee payroll country — review the recorded assignment.`);
        employee.effective_filing_account_id = assignment.filingAccountId;
        employee.filing_account_country = account.country;
        employee.filing_account_number = account.account_number;
      }
    }
  }
}

/** Append reviewed historical evidence, never overwrite today's settings or posted payroll. */
export async function recordHistoricalEmployerAssignment(input: {
  orgId: string; actorId: string; employeePartyId: string; kind: EmployerAssignmentKind;
  assignmentId: string; expectedCurrentId: string | null; effectiveFrom: string; effectiveTo: string;
  sourceReference: string; reason: string; allowedSubsidiaryIds: PayrollSubsidiaryScope; dryRun: boolean;
}, executor?: SqlExecutor): Promise<{ changed: boolean; id: string | null }> {
  if (![input.employeePartyId,input.assignmentId].every(isUuid) || input.expectedCurrentId !== null && !isUuid(input.expectedCurrentId)
    || !['filing_account','worker_comp'].includes(input.kind) || input.allowedSubsidiaryIds === undefined || typeof input.dryRun !== 'boolean') {
    throw new PayrollError('Choose native employee and assignment IDs, declare the reviewed current value, and specify your legal-entity scope.');
  }
  const allowedSubsidiaryIds = input.allowedSubsidiaryIds;
  if (!isIsoCalendarDate(input.effectiveFrom) || !isIsoCalendarDate(input.effectiveTo) || input.effectiveTo < input.effectiveFrom
    || input.effectiveFrom.slice(0,4) !== input.effectiveTo.slice(0,4) || Number(input.effectiveFrom.slice(0,4)) < 2000 || Number(input.effectiveFrom.slice(0,4)) > 2100) {
    throw new PayrollError('Enter a bounded historical employer assignment within one supported tax year (2000–2100).');
  }
  const sourceReference=input.sourceReference.trim(),reason=input.reason.trim();
  if (!sourceReference || !reason || sourceReference.length>2000 || reason.length>2000) throw new PayrollError('Provide a dated source reference and a reason, each from 1–2000 characters.');
  const apply = async (tx: SqlExecutor) => {
    const authority=await lockActorCommandAuthority(tx,input.orgId,input.actorId,null,'payroll.manage');
    await requirePayrollFeature(tx,input.orgId);
    if (!await available(tx)) throw new PayrollError('Historical employer assignments are not installed — run the authorized database bootstrap before previewing this import.');
    await takeEmployeeTaxYearFences(tx,[employeeTaxYearFenceKey(input.orgId,input.employeePartyId,input.effectiveFrom.slice(0,4))]);
    await lockScopeRows(tx,input.orgId,[{kind:'party',id:input.employeePartyId}],allowedSubsidiaryIds,'share');
    await lockScopeRows(tx,input.orgId,[{kind:'party',id:input.employeePartyId}],authority,'share');
    if (input.effectiveTo>=await businessTodayInTx(tx,input.orgId)) throw new PayrollError('Historical assignments must end before today — use the employee payroll settings for current assignments.');
    const profile=(await tx.execute<{ country: string; subsidiary_id: string | null; filing_account_id: string | null }>(sql`
      select prof.country,p.subsidiary_id,prof.filing_account_id from employee_payroll_profiles prof
      join parties p on p.org_id=prof.org_id and p.id=prof.employee_party_id
      where prof.org_id=${input.orgId} and prof.employee_party_id=${input.employeePartyId} for update of prof`)).rows[0];
    if (!profile?.subsidiary_id) throw new PayrollError('Save this employee’s payroll profile and legal employer before recording an assignment.');
    let current=profile.filing_account_id;
    if (input.kind==='worker_comp') {
      const role=(await tx.execute<{ worker_comp_group_id: string | null }>(sql`select worker_comp_group_id from employee_roles
        where org_id=${input.orgId} and party_id=${input.employeePartyId} order by is_active desc,id limit 1 for share`)).rows[0];
      if (!role) throw new PayrollError('Save the native employee role before recording its historical worker-compensation assignment.');
      current=role.worker_comp_group_id;
    }
    const prior=(await tx.execute<{ id: string; effective_from: string; effective_to: string; target: string; source_reference: string; reason: string; expected_current_id: string | null }>(sql`
      select id,effective_from::text,effective_to::text,coalesce(filing_account_id,worker_comp_group_id)::text as target,source_reference,reason,expected_current_id::text
      from payroll_employee_employer_assignments where org_id=${input.orgId} and employee_party_id=${input.employeePartyId}
        and assignment_kind=${input.kind} and effective_from<=${input.effectiveTo}::date and effective_to>=${input.effectiveFrom}::date for share`)).rows;
    if (prior.length) {
      const p=prior[0]!;
      if (prior.length===1 && p.effective_from===input.effectiveFrom && p.effective_to===input.effectiveTo && p.target===input.assignmentId && p.source_reference===sourceReference && p.reason===reason && p.expected_current_id===input.expectedCurrentId) return {changed:false,id:p.id};
      throw new PayrollError('Another employer assignment covers these dates — review its evidence; this import does not overwrite overlapping history.');
    }
    if (current!==input.expectedCurrentId) throw new PayrollError('The current employer assignment differs from the reviewed value — export and preview the historical assignment again.');
    const target = input.kind==='filing_account'
      ? (await tx.execute(sql`select id from payroll_filing_accounts where org_id=${input.orgId} and id=${input.assignmentId} and country=${profile.country} and (subsidiary_id is null or subsidiary_id=${profile.subsidiary_id}) and is_active for share`)).rows
      : (await tx.execute(sql`select id from worker_comp_groups where org_id=${input.orgId} and id=${input.assignmentId} and is_active for share`)).rows;
    if (target.length!==1) throw new PayrollError('Choose an active assignment in this organization, the employee’s own legal employer and payroll country.');
    if ((await tx.execute(sql`select s.id from pay_stubs s join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id where s.org_id=${input.orgId} and s.employee_party_id=${input.employeePartyId}
        and r.run_status='committed' and d.status<>'voided' and r.pay_date between ${input.effectiveFrom}::date and ${input.effectiveTo}::date limit 1`)).rows.length) {
      throw new PayrollError('Committed payroll already used these dates — preserve its evidence and use a controlled correction run.');
    }
    if(input.dryRun) return {changed:true,id:null};
    const saved=(await tx.execute<{ id: string }>(sql`insert into payroll_employee_employer_assignments
      (org_id,employee_party_id,subsidiary_id,assignment_kind,tax_year,effective_from,effective_to,filing_account_id,worker_comp_group_id,expected_current_id,source_reference,reason,created_by)
      values (${input.orgId},${input.employeePartyId},${profile.subsidiary_id},${input.kind},${Number(input.effectiveFrom.slice(0,4))},
        ${input.effectiveFrom}::date,${input.effectiveTo}::date,${input.kind==='filing_account'?input.assignmentId:null},
        ${input.kind==='worker_comp'?input.assignmentId:null},${input.expectedCurrentId},${sourceReference},${reason},${input.actorId}) returning id`)).rows[0];
    if(!saved) throw new PayrollError('The historical assignment was not saved — reload the employee and preview again.');
    await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values (${input.orgId},'payroll_employee_employer_assignments',${saved.id},'insert',
        ${JSON.stringify({before:null,after:{employeePartyId:input.employeePartyId,subsidiaryId:profile.subsidiary_id,kind:input.kind,
          assignmentId:input.assignmentId,effectiveFrom:input.effectiveFrom,effectiveTo:input.effectiveTo},currentAssignmentId:current,sourceReference,reason})}::jsonb,${input.actorId})`);
    return {changed:true,id:saved.id};
  };
  return executor?inExecutorTransaction(executor,apply):withOrgTransaction(input.orgId,()=>apply(db));
}
