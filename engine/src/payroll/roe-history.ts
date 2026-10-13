import { canonicalDecimal } from '../money/exact-decimal.ts';
import { moneyRefusal } from '../money/decimal-refusal.ts';
import { sql } from 'drizzle-orm';
import { db, withOrgTransaction } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { isIsoCalendarDate } from '../platform/iso-date.ts';
import { fromUnits, toUnits, wholeDigits } from '../money/money.ts';
import { authorizeRoeReportingEmployee, type RoeEmployeeScope } from './roe-separation-facts.ts';
import { takeEmployeeConfigurationFence } from './fences.ts';
import { PayrollError } from './error.ts';

export type RoeReportingSource = {
  sourceFileId:string; sourceVersionId:string; sourceSha256:string;
  sourceReference:string; insuranceReference:string; hoursReference:string; reason:string;
};
export type RoeHistorySubject = RoeEmployeeScope & {employmentId:string;subsidiaryId:string};
export type RoePriorPeriodInput = RoeReportingSource & {
  filingAccountId:string; payScheduleId:string; frequency:'weekly'|'biweekly'|'semi_monthly'|'monthly';
  periodStart:string; periodEnd:string; payDate:string|null; earnedFrom:string|null; earnedTo:string|null;
  insurableEarnings:unknown; insurableHours:unknown; nilPeriod:boolean;
  expectedId:string|null; expectedUpdatedAt:string|null;
};
export type RoeLineEvidenceInput = RoeReportingSource & {
  payStubLineId:string; reportPeriodStart:string; reportPeriodEnd:string;
  earnedFrom:string; earnedTo:string; isInsurable:boolean; insurableHours:unknown;
  expectedId:string|null; expectedUpdatedAt:string|null;
};
export type RoePriorPeriod = {
  id:string; employmentId:string; subsidiaryId:string; filingAccountId:string; payScheduleId:string;frequency:string;
  periodStart:string;periodEnd:string;payDate:string|null;earnedFrom:string|null;earnedTo:string|null;
  insurableEarnings:string;insurableHours:string;nilPeriod:boolean;
  sourceFileId:string;sourceVersionId:string;sourceSha256:string;sourceReference:string;insuranceReference:string;hoursReference:string;
  reason:string;updatedAt:string;
};
export type RoeLineEvidence = {
  id:string;payStubLineId:string;lineSnapshot:Record<string,unknown>;reportPeriodStart:string;reportPeriodEnd:string;
  earnedFrom:string;earnedTo:string;isInsurable:boolean;insurableHours:string;
  sourceFileId:string;sourceVersionId:string;sourceSha256:string;sourceReference:string;insuranceReference:string;hoursReference:string;
  reason:string;updatedAt:string;
};
const SOURCE_COLUMNS=sql`source_file_id as "sourceFileId",source_version_id as "sourceVersionId",source_sha256 as "sourceSha256",
 source_reference as "sourceReference",insurance_reference as "insuranceReference",hours_reference as "hoursReference",
 change_reason as reason,updated_at::text as "updatedAt"`;
const PERIOD_COLUMNS=sql`id,employment_id as "employmentId",subsidiary_id as "subsidiaryId",filing_account_id as "filingAccountId",
 pay_schedule_id as "payScheduleId",frequency,period_start::text as "periodStart",period_end::text as "periodEnd",pay_date::text as "payDate",
 earned_from::text as "earnedFrom",earned_to::text as "earnedTo",insurable_earnings::text as "insurableEarnings",insurable_hours::text as "insurableHours",
 nil_period as "nilPeriod",${SOURCE_COLUMNS}`;
const LINE_COLUMNS=sql`id,pay_stub_line_id as "payStubLineId",line_snapshot as "lineSnapshot",
 report_period_start::text as "reportPeriodStart",report_period_end::text as "reportPeriodEnd",earned_from::text as "earnedFrom",earned_to::text as "earnedTo",
 is_insurable as "isInsurable",insurable_hours::text as "insurableHours",${SOURCE_COLUMNS}`;

function amount(value:unknown,label:string):string {
  const canonical=canonicalDecimal(value,4);
  if(canonical===null||wholeDigits(canonical)>15)throw new PayrollError(moneyRefusal(label,value));
  if(toUnits(canonical)<0n)throw new PayrollError(`${label} cannot be negative`);
  return fromUnits(toUnits(canonical));
}
function dates(from:string,to:string,label:string){
  if(!isIsoCalendarDate(from)||!isIsoCalendarDate(to)||from>to)throw new PayrollError(`${label} needs valid ordered calendar dates`);
}
function source(input:RoeReportingSource):RoeReportingSource {
  if(!isUuid(input.sourceFileId)||!isUuid(input.sourceVersionId)||!/^[a-f0-9]{64}$/.test(input.sourceSha256))throw new PayrollError('Choose the exact native source file version and its SHA-256 hash');
  if([input.sourceReference,input.insuranceReference,input.hoursReference,input.reason].some(value=>typeof value!=='string'))throw new PayrollError('Record the original reporting evidence and an import reason');
  const fields={...input,sourceReference:input.sourceReference.trim(),insuranceReference:input.insuranceReference.trim(),hoursReference:input.hoursReference.trim(),reason:input.reason.trim()};
  if([fields.sourceReference,fields.insuranceReference,fields.hoursReference,fields.reason].some(value=>!value||value.length>2000))throw new PayrollError('Record the original period, insurance and hours sources and a reason, each within 2000 characters');
  return fields;
}
function expected(input:{expectedId:string|null;expectedUpdatedAt:string|null}){
  if((input.expectedId===null)!==(input.expectedUpdatedAt===null)||input.expectedId!==null&&!isUuid(input.expectedId)
    ||input.expectedUpdatedAt!==null&&(typeof input.expectedUpdatedAt!=='string'||!input.expectedUpdatedAt))throw new PayrollError('Reload the current reporting evidence before replacing it');
}
export function validateRoePriorPeriod(input:RoePriorPeriodInput):Omit<RoePriorPeriodInput,'insurableEarnings'|'insurableHours'> & {insurableEarnings:string;insurableHours:string} {
  const qualified=source(input);expected(input);dates(input.periodStart,input.periodEnd,'The prior reporting period');
  if(!isUuid(input.filingAccountId)||!isUuid(input.payScheduleId)||!['weekly','biweekly','semi_monthly','monthly'].includes(input.frequency)
    ||typeof input.nilPeriod!=='boolean')throw new PayrollError('Choose the native filing account, pay schedule and reporting frequency');
  const insurableEarnings=amount(input.insurableEarnings,'Insurable earnings'),insurableHours=amount(input.insurableHours,'Insurable hours');
  if(input.nilPeriod){
    if(input.payDate!==null||input.earnedFrom!==null||input.earnedTo!==null||toUnits(insurableEarnings)!==0n||toUnits(insurableHours)!==0n)throw new PayrollError('A source-qualified nil period has no payment, earned span, insurable earnings or hours');
  }else{
    if(input.payDate===null||!isIsoCalendarDate(input.payDate)||input.earnedFrom===null||input.earnedTo===null)throw new PayrollError('Record the actual payment date and source-qualified earned span');
    dates(input.earnedFrom,input.earnedTo,'The original earned span');
  }
  return {...input,...qualified,insurableEarnings,insurableHours};
}
export function validateRoeLineEvidence(input:RoeLineEvidenceInput):Omit<RoeLineEvidenceInput,'insurableHours'> & {insurableHours:string} {
  const qualified=source(input);expected(input);dates(input.reportPeriodStart,input.reportPeriodEnd,'The statutory reporting allocation');dates(input.earnedFrom,input.earnedTo,'The original earned span');
  const insurableHours=amount(input.insurableHours,'Insurable hours');
  if(!isUuid(input.payStubLineId)||typeof input.isInsurable!=='boolean'||!input.isInsurable&&toUnits(insurableHours)!==0n)throw new PayrollError('Choose the retained earning line and explicit insurance treatment; uninsured lines cannot contribute insured hours');
  return {...input,...qualified,insurableHours};
}
async function authorize(input:RoeHistorySubject,write:boolean){
  if(!isUuid(input.employmentId)||!isUuid(input.subsidiaryId))throw new PayrollError('Choose the reporting evidence employment and legal employer');
  if(write)await takeEmployeeConfigurationFence(db,input.orgId,input.employeePartyId);
  const employee=await authorizeRoeReportingEmployee(input,write?'payroll.run':'payroll.read');
  if(employee.employmentId!==input.employmentId||employee.subsidiaryId!==input.subsidiaryId)throw new PayrollError('Reporting evidence must belong to the selected native employment and legal employer');
}
async function retainSource(input:RoeHistorySubject,ref:RoeReportingSource){
  // Importers upload the source through the native File Cabinet. A private
  // file belonging to another operator is never opened through payroll.
  const rows=(await db.execute(sql`select v.id from file_versions v join files f on f.id=v.file_id
    where f.org_id=${input.orgId} and f.id=${ref.sourceFileId} and v.id=${ref.sourceVersionId}
      and v.content_hash=${ref.sourceSha256} and v.created_by=${input.actorId} for share of f,v`)).rows;
  if(rows.length!==1)throw new PayrollError('Upload the original source to File Cabinet as the importing operator, then select its exact retained version and hash');
}
async function unissued(input:RoeHistorySubject){
  const rows=(await db.execute(sql`select sl.id from payroll_filing_submission_slips sl join payroll_filing_submissions f
    on f.org_id=sl.org_id and f.id=sl.submission_id where sl.org_id=${input.orgId} and sl.row_id=${input.employeePartyId}
      and f.country='CA' and f.filing_key='roe' limit 1`)).rows;
  if(rows.length)throw new PayrollError('An issued ROE retains this employee reporting evidence; its source cannot be changed');
}
async function audit(input:RoeHistorySubject,table:string,id:string,before:unknown,after:unknown,reason:string){
  const rows=(await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${input.orgId},${table},${id},${before?'update':'insert'},${JSON.stringify({before,after,reason})}::jsonb,${input.actorId}) returning id`)).rows;
  if(rows.length!==1)throw new PayrollError('The reporting evidence import audit was not retained');
}
function freshness(current:{id:string;updatedAt:string}|undefined,input:{expectedId:string|null;expectedUpdatedAt:string|null}){
  if((current?.id??null)!==input.expectedId||(current?.updatedAt??null)!==input.expectedUpdatedAt)throw new PayrollError('Reporting evidence changed — reload and review it before replacing the source');
}
function same(current:Record<string,unknown>,values:Record<string,unknown>):boolean {
  return Object.entries(values).every(([key,value])=>current[key]===value);
}

/** Atomically import one qualified period without recreating paid payroll or tax history. */
export async function importRoePriorPeriod(subject:RoeHistorySubject,raw:RoePriorPeriodInput):Promise<RoePriorPeriod>{
  const input=validateRoePriorPeriod(raw);
  return withOrgTransaction(subject.orgId,async()=>{
    await authorize(subject,true);await retainSource(subject,input);
    const current=(await db.execute<RoePriorPeriod>(sql`select ${PERIOD_COLUMNS} from payroll_roe_historical_periods
      where org_id=${subject.orgId} and employment_id=${subject.employmentId}
        and ${input.expectedId===null?sql`period_start=${input.periodStart}::date and period_end=${input.periodEnd}::date`:sql`id=${input.expectedId}::uuid`} for update`)).rows[0];
    const values={employmentId:subject.employmentId,subsidiaryId:subject.subsidiaryId,filingAccountId:input.filingAccountId,payScheduleId:input.payScheduleId,
      frequency:input.frequency,periodStart:input.periodStart,periodEnd:input.periodEnd,payDate:input.payDate,earnedFrom:input.earnedFrom,earnedTo:input.earnedTo,
      insurableEarnings:input.insurableEarnings,insurableHours:input.insurableHours,nilPeriod:input.nilPeriod,
      sourceFileId:input.sourceFileId,sourceVersionId:input.sourceVersionId,sourceSha256:input.sourceSha256,sourceReference:input.sourceReference,
      insuranceReference:input.insuranceReference,hoursReference:input.hoursReference,reason:input.reason};
    if(current&&same(current,values))return current;
    freshness(current,input);await unissued(subject);
    const rows=current?(await db.execute<RoePriorPeriod>(sql`update payroll_roe_historical_periods set
      period_start=${input.periodStart},period_end=${input.periodEnd},filing_account_id=${input.filingAccountId},pay_schedule_id=${input.payScheduleId},frequency=${input.frequency},pay_date=${input.payDate},earned_from=${input.earnedFrom},earned_to=${input.earnedTo},
      insurable_earnings=${input.insurableEarnings},insurable_hours=${input.insurableHours},nil_period=${input.nilPeriod},
      source_file_id=${input.sourceFileId},source_version_id=${input.sourceVersionId},source_sha256=${input.sourceSha256},source_reference=${input.sourceReference},
      insurance_reference=${input.insuranceReference},hours_reference=${input.hoursReference},change_reason=${input.reason},updated_by=${subject.actorId},
      updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where org_id=${subject.orgId} and id=${current.id}
        and updated_at::text=${input.expectedUpdatedAt} returning ${PERIOD_COLUMNS}`)).rows:
      (await db.execute<RoePriorPeriod>(sql`insert into payroll_roe_historical_periods(org_id,employee_party_id,employment_id,subsidiary_id,
      filing_account_id,pay_schedule_id,frequency,period_start,period_end,pay_date,earned_from,earned_to,insurable_earnings,insurable_hours,nil_period,
      source_file_id,source_version_id,source_sha256,source_reference,insurance_reference,hours_reference,change_reason,created_by,updated_by)
      values(${subject.orgId},${subject.employeePartyId},${subject.employmentId},${subject.subsidiaryId},${input.filingAccountId},${input.payScheduleId},${input.frequency},
      ${input.periodStart},${input.periodEnd},${input.payDate},${input.earnedFrom},${input.earnedTo},${input.insurableEarnings},${input.insurableHours},${input.nilPeriod},
      ${input.sourceFileId},${input.sourceVersionId},${input.sourceSha256},${input.sourceReference},${input.insuranceReference},${input.hoursReference},${input.reason},${subject.actorId},${subject.actorId}) returning ${PERIOD_COLUMNS}`)).rows;
    if(rows.length!==1)throw new PayrollError('The prior reporting period was not imported');
    await audit(subject,'payroll_roe_historical_periods',rows[0]!.id,current??null,rows[0],input.reason);return rows[0]!;
  });
}

/** Reporting classification cannot replace a committed earning amount or its source identity. */
export async function qualifyRoeLine(subject:RoeHistorySubject,raw:RoeLineEvidenceInput):Promise<RoeLineEvidence>{
  const input=validateRoeLineEvidence(raw);
  return withOrgTransaction(subject.orgId,async()=>{
    await authorize(subject,true);await retainSource(subject,input);
    const lines=(await db.execute<{snapshot:Record<string,unknown>}>(sql`select public.payroll_roe_reporting_line_snapshot(l.id,l.org_id) as snapshot
      from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id where l.org_id=${subject.orgId} and l.id=${input.payStubLineId}
        and s.employee_party_id=${subject.employeePartyId} and s.employment_id=${subject.employmentId} and d.subsidiary_id=${subject.subsidiaryId}
        and s.currency_code='CAD' and r.run_status='committed' and l.kind='earning' for share of l,s,r,d`)).rows;
    if(lines.length!==1||!lines[0]!.snapshot)throw new PayrollError('Choose one committed Canadian earning line in this employee’s native employment');
    const snapshot=lines[0]!.snapshot;
    if(input.isInsurable&&snapshot.hours!==null&&snapshot.hours!==undefined&&toUnits(String(snapshot.hours))!==toUnits(input.insurableHours))throw new PayrollError('Qualified insurable hours must preserve the retained paid-hour source');
    if(typeof snapshot.earnedFrom==='string'&&input.earnedFrom<snapshot.earnedFrom||typeof snapshot.earnedTo==='string'&&input.earnedTo>snapshot.earnedTo)throw new PayrollError('Qualified earned evidence cannot expand the retained payroll span — correct its native source first');
    const current=(await db.execute<RoeLineEvidence>(sql`select ${LINE_COLUMNS} from payroll_roe_line_evidence
      where org_id=${subject.orgId} and pay_stub_line_id=${input.payStubLineId} for update`)).rows[0];
    const values={payStubLineId:input.payStubLineId,reportPeriodStart:input.reportPeriodStart,reportPeriodEnd:input.reportPeriodEnd,earnedFrom:input.earnedFrom,earnedTo:input.earnedTo,
      isInsurable:input.isInsurable,insurableHours:input.insurableHours,sourceFileId:input.sourceFileId,sourceVersionId:input.sourceVersionId,sourceSha256:input.sourceSha256,
      sourceReference:input.sourceReference,insuranceReference:input.insuranceReference,hoursReference:input.hoursReference,reason:input.reason};
    if(current&&same(current,values)&&JSON.stringify(current.lineSnapshot)===JSON.stringify(snapshot))return current;
    freshness(current,input);await unissued(subject);
    const rows=current?(await db.execute<RoeLineEvidence>(sql`update payroll_roe_line_evidence set line_snapshot=${JSON.stringify(snapshot)}::jsonb,
      report_period_start=${input.reportPeriodStart},report_period_end=${input.reportPeriodEnd},earned_from=${input.earnedFrom},earned_to=${input.earnedTo},is_insurable=${input.isInsurable},
      insurable_hours=${input.insurableHours},source_file_id=${input.sourceFileId},source_version_id=${input.sourceVersionId},source_sha256=${input.sourceSha256},
      source_reference=${input.sourceReference},insurance_reference=${input.insuranceReference},hours_reference=${input.hoursReference},change_reason=${input.reason},
      updated_by=${subject.actorId},updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
      where org_id=${subject.orgId} and id=${current.id} and updated_at::text=${input.expectedUpdatedAt} returning ${LINE_COLUMNS}`)).rows:
      (await db.execute<RoeLineEvidence>(sql`insert into payroll_roe_line_evidence(org_id,employee_party_id,employment_id,subsidiary_id,pay_stub_line_id,line_snapshot,
      report_period_start,report_period_end,earned_from,earned_to,is_insurable,insurable_hours,source_file_id,source_version_id,source_sha256,
      source_reference,insurance_reference,hours_reference,change_reason,created_by,updated_by)
      values(${subject.orgId},${subject.employeePartyId},${subject.employmentId},${subject.subsidiaryId},${input.payStubLineId},${JSON.stringify(snapshot)}::jsonb,
      ${input.reportPeriodStart},${input.reportPeriodEnd},${input.earnedFrom},${input.earnedTo},${input.isInsurable},${input.insurableHours},${input.sourceFileId},${input.sourceVersionId},${input.sourceSha256},
      ${input.sourceReference},${input.insuranceReference},${input.hoursReference},${input.reason},${subject.actorId},${subject.actorId}) returning ${LINE_COLUMNS}`)).rows;
    if(rows.length!==1)throw new PayrollError('The payroll-line reporting evidence was not retained');
    await audit(subject,'payroll_roe_line_evidence',rows[0]!.id,current??null,rows[0],input.reason);return rows[0]!;
  });
}

export async function readRoeHistoricalEvidence(subject:RoeHistorySubject,range?:{periodFrom:string;periodTo:string}):Promise<{periods:RoePriorPeriod[];lines:RoeLineEvidence[]}>{
  if(range)dates(range.periodFrom,range.periodTo,'The reporting evidence review window');
  return withOrgTransaction(subject.orgId,async()=>{
    await authorize(subject,false);
    const periods=(await db.execute<RoePriorPeriod>(sql`select ${PERIOD_COLUMNS} from payroll_roe_historical_periods
      where org_id=${subject.orgId} and employee_party_id=${subject.employeePartyId} and employment_id=${subject.employmentId} and subsidiary_id=${subject.subsidiaryId}
      ${range?sql`and period_end>=${range.periodFrom}::date and period_start<=${range.periodTo}::date`:sql``}
      order by period_end desc,id limit 107`)).rows;
    const lines=(await db.execute<RoeLineEvidence>(sql`select ${LINE_COLUMNS} from payroll_roe_line_evidence
      where org_id=${subject.orgId} and employee_party_id=${subject.employeePartyId} and employment_id=${subject.employmentId} and subsidiary_id=${subject.subsidiaryId}
      ${range?sql`and report_period_end>=${range.periodFrom}::date and report_period_start<=${range.periodTo}::date`:sql``}
      order by report_period_end desc,id limit 5001`)).rows;
    if(periods.length>106||lines.length>5000)throw new PayrollError('Reporting evidence exceeds the supported per-employee review window — select a bounded reporting period');
    return {periods,lines};
  });
}
