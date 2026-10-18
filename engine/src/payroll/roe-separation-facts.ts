import { sql } from 'drizzle-orm';
import { db, withOrgTransaction } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { isIsoCalendarDate } from '../platform/iso-date.ts';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { requirePayrollFeature } from './feature-gate.ts';
import { takeEmployeeConfigurationFence } from './fences.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from './scope.ts';
import { roeCanadianEmploymentEvidenceSql, selectRoeEvent, parseRoeEventRow, assertRoeLegacySourcesBound, roeEventRow } from './canada/roe-event-source.ts';
import { PayrollError } from './error.ts';

export type RoeSeparationFacts = {
  id: string; employeePartyId: string; employmentId: string | null; subsidiaryId: string | null;
  firstDayWorked: string | null; interruptionOn: string;
  lastInsurableEarningsOn: string; salaryContinuanceEndOn: string | null;
  status: 'draft' | 'confirmed' | 'issued' | 'cancelled';
  changeReason: string; updatedAt: string; sourceReference: string | null;
};
type StoredFacts = RoeSeparationFacts;
export type RoeSeparationEmployee = { employmentId: string; subsidiaryId: string; employerName: string };
async function withSource(record: StoredFacts): Promise<RoeSeparationFacts> {
  if (record.sourceReference !== null) return record;
  const source = (await db.execute<{ source: string | null }>(sql`select changes->>'sourceReference' as source
    from audit_log where org_id=current_setting('app.current_org')::uuid
      and table_name='payroll_roe_separation_events' and row_id=${record.id}
      and changes ? 'sourceReference' order by at desc,id desc limit 1`)).rows[0]?.source ?? null;
  return { ...record, sourceReference: source };
}
const COLUMNS = sql`id, employment_id as "employmentId",subsidiary_id as "subsidiaryId",
 first_day_worked::text as "firstDayWorked",source_reference as "sourceReference", employee_party_id as "employeePartyId", interruption_on::text as "interruptionOn",
 last_insurable_earnings_on::text as "lastInsurableEarningsOn",
 salary_continuance_end_on::text as "salaryContinuanceEndOn", status,
 change_reason as "changeReason", updated_at::text as "updatedAt"`;

export type RoeEmployeeScope = {
  orgId: string; actorId: string; employeePartyId: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
  employmentId?:string;subsidiaryId?:string;eventId?:string;newEvent?:boolean;
};
export async function authorizeRoeReportingEmployee(input: RoeEmployeeScope, permission: 'payroll.read' | 'payroll.run'): Promise<RoeSeparationEmployee> {
  if (![input.orgId, input.actorId, input.employeePartyId].every(isUuid)
    || input.allowedSubsidiaryIds === undefined) throw new PayrollError('Choose a native employee and explicit payroll legal-entity scope');
  await requirePayrollFeature(db, input.orgId);
  if (!await actorHasPermission(db, input.orgId, input.actorId, permission)) throw new PayrollError('Payroll permission is required to review or record separation facts');
  if((input.employmentId===undefined)!==(input.subsidiaryId===undefined)||input.employmentId!==undefined&&(!isUuid(input.employmentId)||!isUuid(input.subsidiaryId)))throw new PayrollError('Choose both the native employment and its legal employer');
  const employee = (await db.execute<{ subsidiary_id: string; country: string | null; employment_id: string; employer_name: string }>(sql`
    select employment.employer_subsidiary_id as subsidiary_id, prof.country, employment.id as employment_id,employer.name as employer_name from parties p
    join employee_roles e on e.org_id=p.org_id and e.party_id=p.id
    left join employee_payroll_profiles prof on prof.org_id=p.org_id and prof.employee_party_id=p.id
    join worker_employments employment on employment.org_id=p.org_id and employment.worker_party_id=p.id
      and ${input.employmentId?sql`employment.id=${input.employmentId} and employment.employer_subsidiary_id=${input.subsidiaryId}`:sql`employment.id=prof.employment_id and employment.employer_subsidiary_id=p.subsidiary_id`}
    join subsidiaries employer on employer.org_id=p.org_id and employer.id=employment.employer_subsidiary_id
    where p.org_id=${input.orgId} and p.id=${input.employeePartyId}
      ${payrollSubsidiaryScopeFilter(sql`employment.employer_subsidiary_id`, input.allowedSubsidiaryIds)}
    and ${roeCanadianEmploymentEvidenceSql()}
    for share of p,e,employment,employer`)).rows;
  if (employee.length !== 1 || !employee[0]!.subsidiary_id) {
    throw new PayrollError('Choose one Canadian employee with a native legal employer in your payroll scope');
  }
  const authority = await lockActorCommandAuthority(db, input.orgId, input.actorId, employee[0]!.subsidiary_id!, permission);
  const scoped = (await db.execute(sql`select id from worker_employments p where p.org_id=${input.orgId}
    and p.worker_party_id=${input.employeePartyId} and p.id=${employee[0]!.employment_id} ${payrollSubsidiaryScopeFilter(sql`p.employer_subsidiary_id`, authority)}`)).rows;
  if (scoped.length !== 1) throw new PayrollError('The employee is outside your current payroll authority');
  return { employmentId: employee[0]!.employment_id, subsidiaryId: employee[0]!.subsidiary_id, employerName: employee[0]!.employer_name };
}

/**
 * Dates an operator reviews before declaring a new separation event, read from
 * the employment's own records: service start (or hire date, or the first
 * committed pay period), the recorded termination, and the last committed
 * Canadian pay period up to that termination. Nothing is stored until the
 * employer saves them; a date the records do not hold stays null.
 */
export type RoeSeparationProposal = {
  firstDayWorked: string | null; interruptionOn: string | null;
  lastInsurableEarningsOn: string | null; sourceReference: string;
};
async function proposeRoeSeparationFacts(orgId: string, employeePartyId: string, employee: RoeSeparationEmployee): Promise<RoeSeparationProposal | null> {
  const row = (await db.execute<{ serviceStart: string | null; hiredOn: string | null; terminatedOn: string | null;
    firstPeriodStart: string | null; lastPeriodEnd: string | null; lastPayDate: string | null }>(sql`
    with spell as (
      select employment.service_start, role.hired_on,
        coalesce(role.terminated_on, (select v.effective_from from worker_employment_versions v
          where v.org_id=employment.org_id and v.employment_id=employment.id and v.status='terminated'
            and v.recorded_until is null order by v.effective_from desc limit 1)) as terminated_on
      from worker_employments employment
      left join employee_roles role on role.org_id=employment.org_id and role.party_id=employment.worker_party_id
      where employment.org_id=${orgId} and employment.id=${employee.employmentId}
        and employment.worker_party_id=${employeePartyId} and employment.employer_subsidiary_id=${employee.subsidiaryId}
    ), stubs as (
      select r.period_start, r.period_end, s.pay_date from pay_stubs s
      join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id and r.run_status='committed'
      join documents d on d.org_id=r.org_id and d.id=r.document_id and d.subsidiary_id=${employee.subsidiaryId}
      cross join spell
      where s.org_id=${orgId} and s.employee_party_id=${employeePartyId} and s.employment_id=${employee.employmentId}
        and s.currency_code='CAD' and (spell.terminated_on is null or r.period_start<=spell.terminated_on)
    )
    select spell.service_start::text as "serviceStart", spell.hired_on::text as "hiredOn", spell.terminated_on::text as "terminatedOn",
      (select min(period_start)::text from stubs) as "firstPeriodStart", (select max(period_end)::text from stubs) as "lastPeriodEnd",
      (select max(pay_date)::text from stubs) as "lastPayDate"
    from spell`)).rows[0];
  if (!row) return null;
  const firstDayWorked = row.serviceStart ?? row.hiredOn ?? row.firstPeriodStart;
  const lastInsurableEarningsOn = row.lastPeriodEnd && row.terminatedOn && row.terminatedOn < row.lastPeriodEnd
    ? row.terminatedOn : row.lastPeriodEnd ?? row.terminatedOn;
  const interruptionOn = row.terminatedOn ?? lastInsurableEarningsOn;
  const sources = [
    row.serviceStart ? `service start ${row.serviceStart}` : row.hiredOn ? `hire date ${row.hiredOn}`
      : row.firstPeriodStart ? `first committed pay period starting ${row.firstPeriodStart}` : null,
    row.terminatedOn ? `termination ${row.terminatedOn}` : null,
    row.lastPeriodEnd ? `committed pay stubs through the period ending ${row.lastPeriodEnd} (paid ${row.lastPayDate})` : null,
  ].filter(Boolean);
  if (!sources.length) return null;
  return { firstDayWorked, interruptionOn, lastInsurableEarningsOn, sourceReference: `Employment and payroll records: ${sources.join('; ')}` };
}

export async function readRoeSeparationFactsContext(input: RoeEmployeeScope): Promise<{ employee: RoeSeparationEmployee; record: RoeSeparationFacts | null; proposal: RoeSeparationProposal | null }> {
  return withOrgTransaction(input.orgId, async () => {
    let record:StoredFacts|null=null;
    if(input.newEvent && input.eventId) throw new PayrollError('Choose an existing event or start a new separation event');
    if(input.eventId){
      const event=await selectRoeEvent(input.orgId,input.employeePartyId,input.eventId);
      if(input.employmentId!==undefined && input.employmentId!==event.employmentId
        || input.subsidiaryId!==undefined && input.subsidiaryId!==event.subsidiaryId)
        throw new PayrollError('The selected event belongs to a different native employment or employer');
      const scope={...input,employmentId:event.employmentId,subsidiaryId:event.subsidiaryId};
      const employee=await authorizeRoeReportingEmployee(scope,'payroll.read');
      record=(await db.execute<StoredFacts>(sql`select ${COLUMNS} from payroll_roe_separation_events where org_id=${input.orgId} and id=${event.id}`)).rows[0]??null;
      return {employee,record:record?await withSource(record):null,proposal:null};
    }
    const employee=await authorizeRoeReportingEmployee(input,'payroll.read');
    if(input.newEvent) return {employee,record:null,proposal:null};
    const records=(await db.execute<StoredFacts>(sql`select ${COLUMNS} from payroll_roe_separation_events
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and status in ('draft','confirmed','issued')
      order by interruption_on,id limit 2`)).rows;
    if(records.length>1)throw new PayrollError('Select the exact separation event to review its facts');
    record=records[0]??null;
    if(record) return { employee, record: await withSource(record), proposal: null };
    return { employee, record: null, proposal: await proposeRoeSeparationFacts(input.orgId, input.employeePartyId, employee) };
  });
}

export async function readRoeSeparationFacts(input: RoeEmployeeScope): Promise<RoeSeparationFacts | null> {
  return (await readRoeSeparationFactsContext(input)).record;
}

/** Confirmed dates are employer declarations; payroll payment dates do not supply them. */
export async function saveRoeSeparationFacts(input: RoeEmployeeScope & {
  employmentId: string; subsidiaryId: string; firstDayWorked: string | null;
  interruptionOn: string; lastInsurableEarningsOn: string; salaryContinuanceEndOn: string | null;
  sourceReference: string; reason: string; status: 'draft' | 'confirmed';
  expectedId: string | null; expectedUpdatedAt: string | null;
}): Promise<RoeSeparationFacts> {
  if (!isUuid(input.employmentId) || !isUuid(input.subsidiaryId)) throw new PayrollError('Choose the native employment and legal employer for this separation');
  if (input.status === 'confirmed' && input.firstDayWorked === null) throw new PayrollError('Confirm the first day worked in this employment spell from the original separation source');
  if (input.firstDayWorked !== null && !isIsoCalendarDate(input.firstDayWorked)) throw new PayrollError('The declared first day worked must be a real YYYY-MM-DD date');
  if (!isIsoCalendarDate(input.interruptionOn) || !isIsoCalendarDate(input.lastInsurableEarningsOn)
    || input.salaryContinuanceEndOn !== null && !isIsoCalendarDate(input.salaryContinuanceEndOn)) {
    throw new PayrollError('Separation dates must be real calendar dates in YYYY-MM-DD format');
  }
  if (input.firstDayWorked !== null && input.firstDayWorked > input.lastInsurableEarningsOn) throw new PayrollError('The first day worked must not follow the last day of insurable earnings');
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
    await requirePayrollFeature(db, input.orgId);
    if (!await actorHasPermission(db, input.orgId, input.actorId, 'payroll.run')) throw new PayrollError('Payroll run permission is required to record separation facts');
    await takeEmployeeConfigurationFence(db, input.orgId, input.employeePartyId);
    const employee = await authorizeRoeReportingEmployee(input, 'payroll.run');
    if (employee.employmentId !== input.employmentId || employee.subsidiaryId !== input.subsidiaryId) throw new PayrollError('The separation must belong to this employee’s native employment and legal employer');
    const current=input.expectedId===null?null:(await db.execute<StoredFacts>(sql`select ${COLUMNS} from payroll_roe_separation_events
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and id=${input.expectedId}
        and status in ('draft','confirmed','issued') for update`)).rows[0]??null;
    await assertRoeLegacySourcesBound(input.orgId,input.employeePartyId);
    if ((current?.id ?? null) !== input.expectedId || (current?.updatedAt ?? null) !== input.expectedUpdatedAt) {
      throw new PayrollError('Separation facts changed — reload them and review the current dates before saving');
    }
    if(current?.status==='issued'||current&&(await db.execute(sql`select id from payroll_roe_issued_event_sources
      where org_id=${input.orgId} and event_id=${current.id} limit 1`)).rows.length){
      throw new PayrollError('This issued ROE event retains its source facts — preserve them and use the Service Canada correction workflow');
    }
    if(!current && (await db.execute(sql`select id from payroll_roe_separation_events
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and status in ('draft','confirmed') limit 1`)).rows.length)
      throw new PayrollError('This employee already has an open separation event — review that event before starting another');
    if(input.firstDayWorked!==null && (await db.execute(sql`select id from payroll_roe_separation_events
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and employment_id=${input.employmentId}
        and status in ('confirmed','issued') ${current?sql`and id<>${current.id}`:sql``}
        and first_day_worked<=${input.salaryContinuanceEndOn??input.lastInsurableEarningsOn}::date
        and coalesce(salary_continuance_end_on,last_insurable_earnings_on)>=${input.firstDayWorked}::date limit 1`)).rows.length)
      throw new PayrollError('Employment-spell dates overlap another confirmed separation event — reconcile the original spell evidence');
    const currentWithSource = current ? await withSource(current) : null;
    if (currentWithSource && currentWithSource.employmentId === input.employmentId
      && currentWithSource.subsidiaryId === input.subsidiaryId && currentWithSource.firstDayWorked === input.firstDayWorked
      && currentWithSource.interruptionOn === input.interruptionOn
      && currentWithSource.lastInsurableEarningsOn === input.lastInsurableEarningsOn
      && currentWithSource.salaryContinuanceEndOn === input.salaryContinuanceEndOn
      && currentWithSource.status === input.status && currentWithSource.changeReason === reason
      && currentWithSource.sourceReference === sourceReference) return currentWithSource;
    const rows = current
      ? (await db.execute<StoredFacts>(sql`update payroll_roe_separation_events set
        employment_id=${input.employmentId},subsidiary_id=${input.subsidiaryId},first_day_worked=${input.firstDayWorked},source_reference=${sourceReference},
        interruption_on=${input.interruptionOn},last_insurable_earnings_on=${input.lastInsurableEarningsOn},
        salary_continuance_end_on=${input.salaryContinuanceEndOn},status=${input.status},change_reason=${reason},
        updated_by=${input.actorId},updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
        where org_id=${input.orgId} and id=${current.id} and updated_at::text=${input.expectedUpdatedAt}
        returning ${COLUMNS}`)).rows
      : (await db.execute<StoredFacts>(sql`insert into payroll_roe_separation_events
        (org_id,employee_party_id,employment_id,subsidiary_id,first_day_worked,source_reference,interruption_on,last_insurable_earnings_on,salary_continuance_end_on,
         status,change_reason,created_by,updated_by)
        values (${input.orgId},${input.employeePartyId},${input.employmentId},${input.subsidiaryId},${input.firstDayWorked},${sourceReference},${input.interruptionOn},${input.lastInsurableEarningsOn},
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

/** Hold declared facts stable through the native artifact's issued snapshot. */
export async function lockRoeIssueFacts(orgId:string,actorId:string,rowIds:readonly string[],pendingSubmissionId?:string):Promise<void>{
 if(!isUuid(orgId)||!isUuid(actorId)||!rowIds.length)throw new PayrollError('Choose native separation events before issuing ROEs');
 await requirePayrollFeature(db,orgId);
 for(const rowId of [...new Set(rowIds)].sort()){
  const selected=parseRoeEventRow(rowId);if(!selected)throw new PayrollError('Choose a valid native separation event');
  await takeEmployeeConfigurationFence(db,orgId,selected.employeePartyId);
  const event=await selectRoeEvent(orgId,selected.employeePartyId,selected.eventId);
  await authorizeRoeReportingEmployee({orgId,actorId,employeePartyId:selected.employeePartyId,employmentId:event.employmentId,subsidiaryId:event.subsidiaryId,allowedSubsidiaryIds:null},'payroll.run');
  await assertRoeLegacySourcesBound(orgId,selected.employeePartyId,pendingSubmissionId);
  const facts=(await db.execute<StoredFacts>(sql`select ${COLUMNS} from payroll_roe_separation_events where org_id=${orgId} and id=${event.id} for update`)).rows;
  if(facts.length!==1||facts[0]!.status!=='confirmed'||!facts[0]!.firstDayWorked||!facts[0]!.sourceReference)
    throw new PayrollError('Confirm the exact selected employment-spell and separation event before issuing its ROE');
 }
}

/** Retain exact source ownership without reinterpreting a prior issued artifact. */
export async function recordRoeFactsIssued(orgId:string,actorId:string,rowIds:readonly string[],submissionId:string):Promise<void>{
 if(!isUuid(submissionId))throw new PayrollError('Record the native ROE filing artifact before binding its event');
 await lockRoeIssueFacts(orgId,actorId,rowIds,submissionId);
 for(const rowId of [...new Set(rowIds)].sort()){
  const selected=parseRoeEventRow(rowId)!;
  const event=await selectRoeEvent(orgId,selected.employeePartyId,selected.eventId);
  const canonical=roeEventRow(selected.employeePartyId,event.id);
  const slips=(await db.execute<{id:string}>(sql`select sl.id from payroll_filing_submission_slips sl
    join payroll_filing_submissions f on f.org_id=sl.org_id and f.id=sl.submission_id
    where sl.org_id=${orgId} and f.id=${submissionId} and f.country='CA' and f.filing_key='roe' and sl.row_id=${canonical}`)).rows;
  if(slips.length!==1)throw new PayrollError('The issued artifact does not retain this exact employee separation event');
  const {roeWindowContext,readRoeReportingWindow}=await import('./roe-reporting-window.ts');
  const reporting=await readRoeReportingWindow(await roeWindowContext(orgId,selected.employeePartyId,event.id));
  const periods=reporting.historicalPeriods.map(p=>p.id);
  const excluded=reporting.excludedLaterStubIds;
  const lines=[...new Set(reporting.sourceDocuments.flatMap(p=>p.reportingEvidenceIds??[]))];
  const bound=(await db.execute<{id:string;sourceSha256:string}>(sql`
    with snapshot as (select public.payroll_roe_issued_source_snapshot_with_returns(${orgId}::uuid,${event.id}::uuid,
      ${`{${periods.join(',')}}`}::uuid[],${`{${lines.join(',')}}`}::uuid[],${`{${excluded.join(',')}}`}::uuid[]) as body)
    insert into payroll_roe_issued_event_sources(org_id,event_id,employee_party_id,issued_slip_id,historical_period_ids,line_evidence_ids,excluded_stub_ids,source_snapshot,source_sha256,created_by)
    select ${orgId},${event.id},${selected.employeePartyId},${slips[0]!.id},
      ${`{${periods.join(',')}}`}::uuid[],${`{${lines.join(',')}}`}::uuid[],${`{${excluded.join(',')}}`}::uuid[],body,encode(public.digest(body::text,'sha256'),'hex'),${actorId}
    from snapshot returning id,source_sha256 as "sourceSha256"`)).rows;
  if(bound.length!==1)throw new PayrollError('The exact issued ROE event source snapshot was not retained');
  const after=(await db.execute(sql`update payroll_roe_separation_events set status='issued',updated_by=${actorId},
    updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where org_id=${orgId} and id=${event.id} and status='confirmed' returning id`)).rows;
  if(after.length!==1)throw new PayrollError('The selected ROE event changed before its issued lifecycle was retained');
  const audit=(await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    select ${orgId},'payroll_roe_separation_events',${event.id},'update',
      jsonb_build_object('event','roe_source_issued','submissionId',${submissionId}::text,'sourceBindingId',b.id,
        'sourceSha256',b.source_sha256,'before',b.source_snapshot->'event','after',to_jsonb(e),
        'reportingEvidence',jsonb_build_object('historicalPeriods',b.source_snapshot->'historicalPeriods','lineEvidence',b.source_snapshot->'lineEvidence','excludedLaterService',b.source_snapshot->'excludedLaterService')),
      ${actorId} from payroll_roe_issued_event_sources b join payroll_roe_separation_events e on e.org_id=b.org_id and e.id=b.event_id
      where b.org_id=${orgId} and b.id=${bound[0]!.id} returning id`)).rows;
  if(audit.length!==1)throw new PayrollError('The issued ROE event and exact source audit were not retained');
 }
}
