import { sql } from 'drizzle-orm';
import { orgFeatureEnabled } from '../../organization/org-feature-lock.ts';
import { requireAggregateBenefitsRead } from '../authorization.ts';
import { BenefitsError } from './errors.ts';
import { requireId, type SqlExecutor } from './shared.ts';
import { awardPayrollProcessedSql } from './payroll-delivery-evidence.ts';
import { benefitsProgramPage } from './list-window.ts';
export { benefitsProgramPage } from './list-window.ts';

export type BenefitsNativeKind = 'insured' | 'employer' | 'entitlement';
export type BenefitsProgramType = 'health' | 'retirement' | 'allowance' | 'reward' | 'incentive' | 'custom' | 'time_off' | 'recovery';
export interface BenefitsProgramCatalogRow extends Record<string, unknown> {
  id: string; nativeId: string; nativeKind: BenefitsNativeKind; type: BenefitsProgramType;
  code: string; name: string; status: string; currency: string | null; legalEntityId: string | null;
  effectiveFrom: string | null; effectiveTo: string | null; parentProgramIds: string[];
}
export interface BenefitsCatalogQuery { limit?: number; offset?: number; includeInternal?: boolean }
export interface BenefitsParticipantQuery { employeePartyId?: string; programId?: string; limit?: number; offset?: number }
export interface BenefitsProgramParticipant extends Record<string, unknown> {
  id: string; programId: string; nativeKind: 'enrollment' | 'membership' | 'vacation_terms';
  employmentId: string; employeePartyId: string; employeeName: string; status: string;
  effectiveFrom: string; effectiveTo: string | null;
}
export interface BenefitsProgramActivity extends Record<string, unknown> {
  id: string; programId: string; nativeKind: 'award' | 'benefit_allocation' | 'entitlement_ledger';
  employmentId: string; employeePartyId: string; employeeName: string; status: string;
  amount: string; currency: string | null; unit: 'money' | 'hours'; onDate: string; payRunDocumentId: string | null; payrollProcessed: boolean;
}
export interface BenefitsProgramWorkspace {
  program: BenefitsProgramCatalogRow;
  nativeRecord: Record<string, unknown>;
  participants: BenefitsProgramParticipant[];
  activity: BenefitsProgramActivity[];
  hasMoreParticipants: boolean;
  hasMoreActivity: boolean;
}

const catalogProjection = sql`
  select c.id::text as id,c.id::text as "nativeId",'insured'::text as "nativeKind",
    case when lower(p.kind) in ('retirement','pension','rrsp','savings') then 'retirement'
      when lower(p.kind) in ('health','medical','dental','vision','life','disability','insurance') then 'health' else 'custom' end as type,
    p.code,p.name,case when p.is_active then 'active' else 'inactive' end as status,p.currency::text as currency,
    p.employer_subsidiary_id::text as "legalEntityId",p.effective_from::text as "effectiveFrom",p.effective_to::text as "effectiveTo",
    '[]'::jsonb as "parentProgramIds",to_jsonb(p) as "nativeRecord"
  from hrm_benefit_catalog c join hrm_benefit_plans p on p.org_id=c.org_id and p.id=c.insured_plan_id
  union all
  select c.id::text,c.id::text,'employer',p.family,p.code,p.name,p.status,p.currency,p.legal_entity_id::text,
    p.effective_from::text,p.effective_to::text,'[]'::jsonb,to_jsonb(p)
  from hrm_benefit_catalog c join hrm_benefit_programs p on p.org_id=c.org_id and p.id=c.employer_program_id
  union all
  select c.id::text,c.id::text,'entitlement',case when p.direction='owe' then 'recovery' else 'time_off' end,
    p.code,p.name,case when p.is_active then 'active' else 'inactive' end,null::text,null::text,null::text,null::text,
    coalesce((select jsonb_agg(distinct r.plan_id::text) from hrm_benefit_contribution_rules r where r.org_id=p.org_id and r.arrears_plan_id=p.id),'[]'::jsonb),to_jsonb(p)
  from hrm_benefit_catalog c join entitlement_plans p on p.org_id=c.org_id and p.id=c.entitlement_plan_id`;

function scopeFence(scope: Set<string> | null, column: ReturnType<typeof sql>) {
  return scope === null ? sql`true` : sql`${column}=any(${`{${[...scope].join(',')}}`}::uuid[])`;
}
function programScopeFence(scope: Set<string> | null) {
  return scope === null ? sql`true` : sql`((offering."nativeKind"<>'employer' and offering."legalEntityId" is null) or ${scopeFence(scope,sql`offering."legalEntityId"::uuid`)})`;
}

/** Native rules, names and lifecycle are read live; the identity contains no competing configuration. */
export async function listBenefitsProgramCatalog(exec: SqlExecutor, orgId: string, actorId: string, query: BenefitsCatalogQuery = {}): Promise<BenefitsProgramCatalogRow[]> {
  const scope = await requireAggregateBenefitsRead(exec,orgId,actorId), { limit,offset } = benefitsProgramPage(query);
  const payroll = await orgFeatureEnabled(orgId,'payroll',exec);
  const rows = (await exec.execute<BenefitsProgramCatalogRow & { nativeRecord: Record<string, unknown> }>(sql`
    select offering.* from (${catalogProjection}) offering
    join hrm_benefit_catalog identity on identity.id::text=offering.id and identity.org_id=${orgId}::uuid
    where ${programScopeFence(scope)}
      ${payroll ? sql`` : sql`and offering."nativeKind"<>'entitlement'`}
      ${query.includeInternal ? sql`` : sql`and jsonb_array_length(offering."parentProgramIds")=0`}
    order by offering.name,offering.id limit ${limit} offset ${offset}`)).rows;
  return rows.map(({ nativeRecord: _nativeRecord,...row }) => row);
}

const participantProjection = sql`
  select e.id,e.org_id,e.plan_id as program_id,'enrollment'::text as native_kind,e.employment_id,e.status,e.effective_from,e.effective_to
    from hrm_benefit_enrollments e
  union all
  select m.id,m.org_id,m.program_id,'membership',m.employment_id,'assigned',m.effective_from,m.effective_to from hrm_benefit_program_members m
  union all
  select t.id,t.org_id,t.plan_id,'vacation_terms',t.employment_id,'assigned',t.effective_from,t.effective_to from payroll_vacation_terms t`;

/** Participants are real native assignments; ledger history is not misrepresented as enrollment. */
export async function listBenefitsProgramParticipants(exec: SqlExecutor, orgId: string, actorId: string, query: BenefitsParticipantQuery = {}): Promise<BenefitsProgramParticipant[]> {
  const scope = await requireAggregateBenefitsRead(exec,orgId,actorId), { limit,offset } = benefitsProgramPage(query);
  const payroll = await orgFeatureEnabled(orgId,'payroll',exec);
  if (query.programId) requireId(query.programId,'programId');
  if (query.employeePartyId) requireId(query.employeePartyId,'employeePartyId');
  return (await exec.execute<BenefitsProgramParticipant>(sql`
    select a.id::text,a.program_id::text as "programId",a.native_kind as "nativeKind",a.employment_id::text as "employmentId",
      e.worker_party_id::text as "employeePartyId",p.display_name as "employeeName",a.status,
      a.effective_from::text as "effectiveFrom",a.effective_to::text as "effectiveTo"
    from (${participantProjection}) a
    join (${catalogProjection}) offering on offering.id=a.program_id::text
    join worker_employments e on e.org_id=a.org_id and e.id=a.employment_id
    join parties p on p.org_id=e.org_id and p.id=e.worker_party_id
    where a.org_id=${orgId}::uuid and ${scopeFence(scope,sql`e.employer_subsidiary_id`)} and ${programScopeFence(scope)}
      ${payroll ? sql`` : sql`and a.native_kind<>'vacation_terms'`}
      ${query.programId ? sql`and a.program_id=${query.programId}::uuid` : sql``}
      ${query.employeePartyId ? sql`and e.worker_party_id=${query.employeePartyId}::uuid` : sql``}
    order by p.display_name,a.program_id,a.effective_from desc,a.id limit ${limit} offset ${offset}`)).rows;
}

const activityProjection = sql`
  select a.id,a.org_id,a.program_id,'award'::text as native_kind,a.employment_id,a.status,
    a.value::text as amount,a.currency::text,'money'::text as unit,a.period_from as on_date,a.pay_run_document_id,${awardPayrollProcessedSql} as payroll_processed
    from hrm_benefit_awards a join hrm_benefit_programs p on p.org_id=a.org_id and p.id=a.program_id
  union all
  select a.id,a.org_id,e.plan_id,'benefit_allocation',a.employment_id,a.status,a.amount::text,a.currency::text,'money',a.period_from,a.pay_run_document_id,
    (a.status='committed' and exists(select 1 from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
      join pay_stub_lines l on l.org_id=a.org_id and l.id=a.pay_stub_line_id
      join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
      where r.org_id=a.org_id and r.document_id=a.pay_run_document_id and r.run_status='committed' and d.status<>'voided'
        and s.pay_run_document_id=r.document_id and s.employment_id=a.employment_id and s.currency_code=a.currency and l.amount=a.amount))
    from pay_run_benefit_allocations a join hrm_benefit_enrollments e on e.org_id=a.org_id and e.id=a.enrollment_id
  union all
  select l.id,l.org_id,l.plan_id,'entitlement_ledger',l.employment_id,l.kind,l.amount::text,d.currency::text,p.unit,l.movement_date,l.pay_run_document_id,
    (d.status<>'voided' and exists(select 1 from pay_runs r where r.org_id=l.org_id and r.document_id=l.pay_run_document_id and r.run_status='committed'))
    from entitlement_ledger l join entitlement_plans p on p.org_id=l.org_id and p.id=l.plan_id
    left join documents d on d.org_id=l.org_id and d.id=l.pay_run_document_id`;

export async function listBenefitsProgramActivity(exec: SqlExecutor, orgId: string, actorId: string, query: BenefitsParticipantQuery = {}): Promise<BenefitsProgramActivity[]> {
  const scope = await requireAggregateBenefitsRead(exec,orgId,actorId), { limit,offset } = benefitsProgramPage(query);
  const payroll = await orgFeatureEnabled(orgId,'payroll',exec);
  if (query.programId) requireId(query.programId,'programId');
  if (query.employeePartyId) requireId(query.employeePartyId,'employeePartyId');
  return (await exec.execute<BenefitsProgramActivity>(sql`
    select a.id::text,a.program_id::text as "programId",a.native_kind as "nativeKind",a.employment_id::text as "employmentId",
      e.worker_party_id::text as "employeePartyId",p.display_name as "employeeName",a.status,a.amount,a.currency,a.unit,
      a.on_date::text as "onDate",a.pay_run_document_id::text as "payRunDocumentId",coalesce(a.payroll_processed,false) as "payrollProcessed"
    from (${activityProjection}) a
    join (${catalogProjection}) offering on offering.id=a.program_id::text
    join worker_employments e on e.org_id=a.org_id and e.id=a.employment_id
    join parties p on p.org_id=e.org_id and p.id=e.worker_party_id
    where a.org_id=${orgId}::uuid and ${scopeFence(scope,sql`e.employer_subsidiary_id`)} and ${programScopeFence(scope)}
      ${payroll ? sql`` : sql`and a.native_kind='award'`}
      ${query.programId ? sql`and a.program_id=${query.programId}::uuid` : sql``}
      ${query.employeePartyId ? sql`and e.worker_party_id=${query.employeePartyId}::uuid` : sql``}
    order by a.on_date desc,a.id limit ${limit} offset ${offset}`)).rows;
}

/** One identity resolves the native record and scoped employee evidence in its program workspace. */
export async function getBenefitsProgramWorkspace(exec: SqlExecutor, orgId: string, actorId: string, programId: string, query: { participantOffset?: number; activityOffset?: number } = {}): Promise<BenefitsProgramWorkspace> {
  requireId(programId,'programId');
  const scope = await requireAggregateBenefitsRead(exec,orgId,actorId);
  const stored = (await exec.execute<BenefitsProgramCatalogRow & { nativeRecord: Record<string,unknown> }>(sql`
    select offering.* from (${catalogProjection}) offering
    join hrm_benefit_catalog identity on identity.id::text=offering.id and identity.org_id=${orgId}::uuid
    where identity.id=${programId}::uuid and ${programScopeFence(scope)}`)).rows[0];
  if (!stored) throw new BenefitsError('NOT_FOUND','This program is unavailable in your organization or legal-entity scope; reopen Programs.');
  if (stored.nativeKind==='entitlement' && !(await orgFeatureEnabled(orgId,'payroll',exec))) throw new BenefitsError('REFUSED','Enable Payroll under Company Settings → Features to access entitlement programs; existing program history is preserved.');
  const {nativeRecord,...program} = stored;
  const participants = await listBenefitsProgramParticipants(exec,orgId,actorId,{programId,limit:101,offset:query.participantOffset});
  const activity = await listBenefitsProgramActivity(exec,orgId,actorId,{programId,limit:101,offset:query.activityOffset});
  return {program,nativeRecord,participants:participants.slice(0,100),activity:activity.slice(0,100),hasMoreParticipants:participants.length>100,hasMoreActivity:activity.length>100};
}
