import { sql } from 'drizzle-orm';
import { db, withOrgTransaction } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { isIsoCalendarDate } from '../platform/iso-date.ts';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { requirePayrollFeature } from './feature-gate.ts';
import { takeEmployeeConfigurationFence } from './fences.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from './scope.ts';
import { PayrollError } from './error.ts';

export type RoeSeparationFacts = {
  id: string; employeePartyId: string; interruptionOn: string;
  lastInsurableEarningsOn: string; salaryContinuanceEndOn: string | null;
  status: 'draft' | 'confirmed' | 'issued' | 'cancelled';
  changeReason: string; updatedAt: string; sourceReference: string | null;
};
type StoredFacts = Omit<RoeSeparationFacts, 'sourceReference'>;
async function withSource(record: StoredFacts): Promise<RoeSeparationFacts> {
  const source = (await db.execute<{ source: string | null }>(sql`select changes->>'sourceReference' as source
    from audit_log where org_id=current_setting('app.current_org')::uuid
      and table_name='payroll_roe_separation_events' and row_id=${record.id}
      and changes ? 'sourceReference' order by at desc,id desc limit 1`)).rows[0]?.source ?? null;
  return { ...record, sourceReference: source };
}
const COLUMNS = sql`id, employee_party_id as "employeePartyId", interruption_on::text as "interruptionOn",
 last_insurable_earnings_on::text as "lastInsurableEarningsOn",
 salary_continuance_end_on::text as "salaryContinuanceEndOn", status,
 change_reason as "changeReason", updated_at::text as "updatedAt"`;

type Scope = {
  orgId: string; actorId: string; employeePartyId: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
};
async function authorize(input: Scope, permission: 'payroll.read' | 'payroll.run') {
  if (![input.orgId, input.actorId, input.employeePartyId].every(isUuid)
    || input.allowedSubsidiaryIds === undefined) throw new PayrollError('Choose a native employee and explicit payroll legal-entity scope');
  await requirePayrollFeature(db, input.orgId);
  if (!await actorHasPermission(db, input.orgId, input.actorId, permission)) throw new PayrollError('Payroll permission is required to review or record separation facts');
  const employee = (await db.execute<{ subsidiary_id: string | null; country: string | null }>(sql`
    select p.subsidiary_id, prof.country from parties p
    join employee_roles e on e.org_id=p.org_id and e.party_id=p.id
    join employee_payroll_profiles prof on prof.org_id=p.org_id and prof.employee_party_id=p.id
    where p.org_id=${input.orgId} and p.id=${input.employeePartyId}
      ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
    for share of p,e,prof`)).rows;
  if (employee.length !== 1 || !employee[0]!.subsidiary_id || employee[0]!.country !== 'CA') {
    throw new PayrollError('Choose one Canadian employee with a native legal employer in your payroll scope');
  }
  const authority = await lockActorCommandAuthority(db, input.orgId, input.actorId, employee[0]!.subsidiary_id!, permission);
  const scoped = (await db.execute(sql`select id from parties p where p.org_id=${input.orgId}
    and p.id=${input.employeePartyId} ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, authority)}`)).rows;
  if (scoped.length !== 1) throw new PayrollError('The employee is outside your current payroll authority');
}

export async function readRoeSeparationFacts(input: Scope): Promise<RoeSeparationFacts | null> {
  return withOrgTransaction(input.orgId, async () => {
    await authorize(input, 'payroll.read');
    const record = (await db.execute<StoredFacts>(sql`select ${COLUMNS} from payroll_roe_separation_events
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId}
      and status in ('draft','confirmed','issued') order by interruption_on desc,id desc limit 1`)).rows[0];
    return record ? withSource(record) : null;
  });
}

/** Confirmed dates are employer declarations; payroll payment dates do not supply them. */
export async function saveRoeSeparationFacts(input: Scope & {
  interruptionOn: string; lastInsurableEarningsOn: string; salaryContinuanceEndOn: string | null;
  sourceReference: string; reason: string; status: 'draft' | 'confirmed';
  expectedId: string | null; expectedUpdatedAt: string | null;
}): Promise<RoeSeparationFacts> {
  if (!isIsoCalendarDate(input.interruptionOn) || !isIsoCalendarDate(input.lastInsurableEarningsOn)
    || input.salaryContinuanceEndOn !== null && !isIsoCalendarDate(input.salaryContinuanceEndOn)) {
    throw new PayrollError('Separation dates must be real calendar dates in YYYY-MM-DD format');
  }
  if (input.lastInsurableEarningsOn > input.interruptionOn || input.salaryContinuanceEndOn !== null
    && (input.salaryContinuanceEndOn < input.lastInsurableEarningsOn || input.salaryContinuanceEndOn > input.interruptionOn)) {
    throw new PayrollError('The last insurable earnings day and any paid-leave or salary-continuance end must precede or equal the interruption date');
  }
  if (!['draft','confirmed'].includes(input.status) || input.expectedId !== null && !isUuid(input.expectedId)
    || (input.expectedId === null) !== (input.expectedUpdatedAt === null)) throw new PayrollError('Reload the separation facts before saving');
  const reason = input.reason.trim(), sourceReference = input.sourceReference.trim();
  if (!reason || reason.length > 2000 || !sourceReference || sourceReference.length > 2000) {
    throw new PayrollError('Record the original separation source and a change reason, each within 2000 characters');
  }
  return withOrgTransaction(input.orgId, async () => {
    await authorize(input, 'payroll.run');
    await takeEmployeeConfigurationFence(db, input.orgId, input.employeePartyId);
    const current = (await db.execute<StoredFacts>(sql`select ${COLUMNS} from payroll_roe_separation_events
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId}
        and status in ('draft','confirmed','issued') order by interruption_on desc,id desc limit 1 for update`)).rows[0] ?? null;
    if ((current?.id ?? null) !== input.expectedId || (current?.updatedAt ?? null) !== input.expectedUpdatedAt) {
      throw new PayrollError('Separation facts changed — reload them and review the current dates before saving');
    }
    if (current?.status === 'issued' || (await db.execute(sql`select sl.id from payroll_filing_submission_slips sl
      join payroll_filing_submissions f on f.org_id=sl.org_id and f.id=sl.submission_id
      where sl.org_id=${input.orgId} and sl.row_id=${input.employeePartyId}
        and f.country='CA' and f.filing_key='roe' limit 1`)).rows.length) {
      throw new PayrollError('An ROE was recorded as issued for this employee — preserve its separation facts and use the Service Canada correction workflow');
    }
    const currentWithSource = current ? await withSource(current) : null;
    if (currentWithSource && currentWithSource.interruptionOn === input.interruptionOn
      && currentWithSource.lastInsurableEarningsOn === input.lastInsurableEarningsOn
      && currentWithSource.salaryContinuanceEndOn === input.salaryContinuanceEndOn
      && currentWithSource.status === input.status && currentWithSource.changeReason === reason
      && currentWithSource.sourceReference === sourceReference) return currentWithSource;
    const rows = current
      ? (await db.execute<StoredFacts>(sql`update payroll_roe_separation_events set
        interruption_on=${input.interruptionOn},last_insurable_earnings_on=${input.lastInsurableEarningsOn},
        salary_continuance_end_on=${input.salaryContinuanceEndOn},status=${input.status},change_reason=${reason},
        updated_by=${input.actorId},updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
        where org_id=${input.orgId} and id=${current.id} and updated_at::text=${input.expectedUpdatedAt}
        returning ${COLUMNS}`)).rows
      : (await db.execute<StoredFacts>(sql`insert into payroll_roe_separation_events
        (org_id,employee_party_id,interruption_on,last_insurable_earnings_on,salary_continuance_end_on,
         status,change_reason,created_by,updated_by)
        values (${input.orgId},${input.employeePartyId},${input.interruptionOn},${input.lastInsurableEarningsOn},
          ${input.salaryContinuanceEndOn},${input.status},${reason},${input.actorId},${input.actorId}) returning ${COLUMNS}`)).rows;
    if (rows.length !== 1) throw new PayrollError('The separation facts were not saved — reload and retry');
    const saved = rows[0]!;
    const audit = (await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values (${input.orgId},'payroll_roe_separation_events',${saved.id},${current ? 'update' : 'insert'},
        ${JSON.stringify({before:currentWithSource,after:{...saved,sourceReference},sourceReference,reason})}::jsonb,${input.actorId}) returning id`)).rows;
    if (audit.length !== 1) throw new PayrollError('The separation source and change audit were not retained');
    return { ...saved, sourceReference };
  });
}
