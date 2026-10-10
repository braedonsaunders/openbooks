import { sql } from 'drizzle-orm';
import { db, withOrgTransaction } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { isIsoCalendarDate } from '../platform/civil-date.ts';
import { canonicalDecimal, compareDecimal } from '../money/exact-decimal.ts';
import { normalizeMoney } from '../money/money.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts';
import { ScopeNotFoundError, subsidiaryScopeAllows } from '../organization/subsidiary-scope.ts';
import { employeePayComponentScopeLock, validateEmployeePayComponentAssignment, type EmployeePayComponentAssignmentInput } from './assigned-components.ts';
import { takeEmployeeConfigurationFence } from './fences.ts';
import { PayrollError } from './error.ts';

export type EmployeePayComponentAssignmentRecord = {
  id: string; employeePartyId: string; employmentId: string | null; componentId: string;
  value: string | null; runApplicability: 'standard_runs' | 'regular_only';
  effectiveFrom: string; effectiveTo: string | null; isActive: boolean;
};
export const EMPLOYEE_PAY_COMPONENT_COLUMNS = sql`id,employee_party_id as "employeePartyId",employment_id as "employmentId",
 component_id as "componentId",value::text as value,run_applicability as "runApplicability",
 effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",is_active as "isActive"`;
type Actor = { orgId: string; actorId: string; reason?: string };

function identifier(value: string): string {
  if (!isUuid(value)) throw new PayrollError('Choose a valid native pay-component assignment reference.');
  return value;
}
function reasonText(value: string | undefined, fallback: string): string {
  if (value !== undefined && (typeof value !== 'string' || value.length > 500)) throw new PayrollError('The assignment reason must be text of at most 500 characters.');
  return value?.trim() || fallback;
}
function date(value: string | null): void {
  if (value !== null && !isIsoCalendarDate(value)) throw new PayrollError('Choose a valid assignment calendar date in YYYY-MM-DD form.');
}
async function locate(orgId: string, id: string, lock = false): Promise<EmployeePayComponentAssignmentRecord> {
  const row = (await db.execute<EmployeePayComponentAssignmentRecord>(sql`select ${EMPLOYEE_PAY_COMPONENT_COLUMNS}
   from employee_pay_components where org_id=${orgId} and id=${id} ${lock ? sql`for update` : sql``}`)).rows[0];
  if (!row) throw new ScopeNotFoundError();
  return row;
}
async function authorize(query: Actor, employeePartyId: string): Promise<void> {
  identifier(query.orgId); identifier(query.actorId); identifier(employeePartyId);
  if (!await lockAndCheckOrgFeature(db, query.orgId, 'payroll')) throw new PayrollError('Payroll is disabled — enable it in Company Settings → Features before configuring assignments.');
  const party = (await db.execute<{ subsidiaryId: string | null }>(sql`select subsidiary_id as "subsidiaryId" from parties
   where org_id=${query.orgId} and id=${employeePartyId} for share`)).rows[0];
  if (!party) throw new ScopeNotFoundError();
  const scope = await lockActorCommandAuthority(db, query.orgId, query.actorId, party.subsidiaryId, 'payroll.manage');
  if (!subsidiaryScopeAllows(scope, party.subsidiaryId)) throw new ScopeNotFoundError();
  await takeEmployeeConfigurationFence(db, query.orgId, employeePartyId);
  await db.execute(employeePayComponentScopeLock(query.orgId, employeePartyId));
}
async function audit(query: Actor, id: string, action: 'insert' | 'update' | 'delete', changes: object): Promise<void> {
  const saved = (await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
   values(${query.orgId},'employee_pay_components',${id},${action},${JSON.stringify(changes)}::jsonb,${query.actorId}) returning id`)).rows;
  if (saved.length !== 1) throw new PayrollError('The assignment audit was not saved; nothing applied.');
}

/** UI, imports and operations share authorization, validation, serialization and audit. */
export async function saveEmployeePayComponentAssignment(query: Actor & Omit<EmployeePayComponentAssignmentInput, 'excludeId'>): Promise<EmployeePayComponentAssignmentRecord> {
  identifier(query.orgId); identifier(query.actorId); identifier(query.employeePartyId);
  identifier(query.componentId); if (query.employmentId !== null) identifier(query.employmentId);
  date(query.effectiveFrom); date(query.effectiveTo);
  const raw = query.value === null ? null : canonicalDecimal(query.value, 4);
  if (query.value !== null && (raw === null || compareDecimal(raw, '999999999999999.9999') > 0 || compareDecimal(raw, '-999999999999999.9999') < 0)) throw new PayrollError('The pay-component value must be exact decimal text within the supported amount range.');
  const value = raw === null ? null : normalizeMoney(raw);
  const reason = reasonText(query.reason, 'pay-component assignment saved');
  return withOrgTransaction(query.orgId, async () => {
    await authorize(query, query.employeePartyId);
    const input = { ...query, value, runApplicability: query.runApplicability ?? 'standard_runs' };
    const validated = await validateEmployeePayComponentAssignment(db, query.orgId, input);
    const inserted = (await db.execute<{ id: string }>(sql`insert into employee_pay_components
     (org_id,employee_party_id,employment_id,component_id,value,run_applicability,effective_from,effective_to,is_active,created_by,updated_by)
     values(${query.orgId},${query.employeePartyId},${query.employmentId},${query.componentId},${value},${input.runApplicability},
      ${query.effectiveFrom}::date,${query.effectiveTo}::date,true,${query.actorId},${query.actorId}) returning id`)).rows;
    if (inserted.length !== 1) throw new PayrollError('The assignment was not saved; nothing applied.');
    const after = await locate(query.orgId, inserted[0]!.id);
    await audit(query, after.id, 'insert', { after, component: validated.componentCode, reason });
    return after;
  });
}

export async function endEmployeePayComponentAssignment(query: Actor & { id: string; effectiveTo: string | null }): Promise<EmployeePayComponentAssignmentRecord> {
  identifier(query.orgId); identifier(query.actorId); identifier(query.id); date(query.effectiveTo);
  const reason = reasonText(query.reason, query.effectiveTo ? 'pay-component assignment ended' : 'pay-component assignment end date cleared');
  return withOrgTransaction(query.orgId, async () => {
    const found = await locate(query.orgId, query.id);
    await authorize(query, found.employeePartyId);
    const before = await locate(query.orgId, query.id, true);
    if (before.employeePartyId !== found.employeePartyId) throw new PayrollError('The assignment employee changed during this save — reload and retry.');
    await validateEmployeePayComponentAssignment(db, query.orgId, { ...before, effectiveTo: query.effectiveTo, excludeId: before.id });
    const changed = (await db.execute(sql`update employee_pay_components set effective_to=${query.effectiveTo}::date,
     updated_at=now(),updated_by=${query.actorId} where org_id=${query.orgId} and id=${before.id} returning id`)).rows;
    if (changed.length !== 1) throw new PayrollError('The assignment changed during this save — reload and retry.');
    const after = await locate(query.orgId, before.id);
    await audit(query, before.id, 'update', { before, after, reason });
    return after;
  });
}

/** Only an assignment whose component has never priced this employee's stub may be removed. */
export async function deleteUnusedEmployeePayComponentAssignment(query: Actor & { id: string }): Promise<void> {
  identifier(query.orgId); identifier(query.actorId); identifier(query.id);
  const reason = reasonText(query.reason, 'pay-component assignment deleted');
  await withOrgTransaction(query.orgId, async () => {
    const found = await locate(query.orgId, query.id);
    await authorize(query, found.employeePartyId);
    const before = await locate(query.orgId, query.id, true);
    if (before.employeePartyId !== found.employeePartyId) throw new PayrollError('The assignment employee changed during this save — reload and retry.');
    const consumed = (await db.execute(sql`select l.id from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
     where l.org_id=${query.orgId} and l.component_id=${before.componentId} and s.employee_party_id=${before.employeePartyId} limit 1`)).rows;
    if (consumed.length > 0) throw new PayrollError('This assignment already priced a pay stub — end it instead of deleting it.');
    const deleted = (await db.execute(sql`delete from employee_pay_components where org_id=${query.orgId} and id=${before.id} returning id`)).rows;
    if (deleted.length !== 1) throw new PayrollError('The assignment changed during this save — reload and retry.');
    await audit(query, before.id, 'delete', { before, reason });
  });
}
