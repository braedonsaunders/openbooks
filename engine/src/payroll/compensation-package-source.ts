import { sql, type SQL } from 'drizzle-orm';
import type { SqlExecutor } from '../platform/db.ts';
import type { payComponents } from '@openbooks/schema';
import type { CompensationPackageDefinition } from './compensation-package.ts';
import { lockCompensationPackageConfiguration } from './compensation-package-store.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from './scope.ts';
import { PayrollError } from './error.ts';

/** Native flags, limits and accounting destinations accompany the approved formula. */
export type CompensationPackageComponentSource = Pick<typeof payComponents.$inferSelect,
  'id' | 'orgId' | 'code' | 'name' | 'kind' | 'country' | 'systemKey' | 'basis' | 'value' |
  'paymentKind' | 'nonCashAccountId' | 'taxable' | 'pensionable' | 'insurable' | 'vacationable' |
  'programExclusions' | 'nonPeriodic' | 'taxTreatment' | 'protectionBase' | 'protectionMaxPercent' |
  'protectionPriority' | 'protectionClass' | 'includeInDisposableEarnings' | 'basisCapHoursPerPeriod' |
  'basisCapAmountPerPeriod' | 'basisCapAmountPerYear' | 'expenseAccountId' | 'liabilityAccountId' |
  'remittancePartyId' | 'sequence' | 'isActive'> & {
    supplementalWageCategory: string | null;
    statutoryReportingCategory: string | null;
    statutoryExemptionCategory: string | null;
  };

export interface CompensationPackageAssignmentSource {
  assignmentId: string;
  packageId: string;
  packageCode: string;
  employmentId: string;
  employeePartyId: string;
  subsidiaryId: string;
  country: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  inputs: Readonly<Record<string, string | boolean>>;
  versionId: string;
  versionEffectiveFrom: string;
  versionEffectiveTo: string | null;
  definition: CompensationPackageDefinition;
  definitionHash: string;
  components: CompensationPackageComponentSource[];
}

const COMPONENT_SOURCE = sql`jsonb_build_object(
  'id',c.id,'orgId',c.org_id,'code',c.code,'name',c.name,'kind',c.kind,'country',c.country,
  'systemKey',c.system_key,'basis',c.basis,'value',c.value::text,
  'paymentKind',c.payment_kind,'nonCashAccountId',c.non_cash_account_id,
  'taxable',c.taxable,'pensionable',c.pensionable,'insurable',c.insurable,'vacationable',c.vacationable,
  'programExclusions',c.program_exclusions,'nonPeriodic',c.non_periodic,'taxTreatment',c.tax_treatment,
  'protectionBase',c.protection_base,'protectionMaxPercent',c.protection_max_percent::text,
  'protectionPriority',c.protection_priority,'protectionClass',c.protection_class,
  'includeInDisposableEarnings',c.include_in_disposable_earnings,
  'basisCapHoursPerPeriod',c.basis_cap_hours_per_period::text,
  'basisCapAmountPerPeriod',c.basis_cap_amount_per_period::text,
  'basisCapAmountPerYear',c.basis_cap_amount_per_year::text,
  'expenseAccountId',c.expense_account_id,'liabilityAccountId',c.liability_account_id,
  'remittancePartyId',c.remittance_party_id,'sequence',c.sequence,'isActive',c.is_active,
  'supplementalWageCategory',ec.supplemental_wage_category,
  'statutoryReportingCategory',ec.statutory_reporting_category,
  'statutoryExemptionCategory',ec.statutory_exemption_category)`;

/** One statement resolves financial sources; the caller owns the surrounding native payroll transaction. */
async function assignmentSources(tx: SqlExecutor, orgId: string, predicate: SQL): Promise<CompensationPackageAssignmentSource[]> {
  await lockCompensationPackageConfiguration(tx, orgId);
  return (await tx.execute<{ source: CompensationPackageAssignmentSource }>(sql`
    select jsonb_build_object(
      'assignmentId',a.id,'packageId',a.package_id,'packageCode',p.code,
      'employmentId',a.employment_id,'employeePartyId',a.employee_party_id,'subsidiaryId',a.subsidiary_id,
      'country',p.country,'currency',p.currency,'effectiveFrom',a.effective_from::text,'effectiveTo',a.effective_to::text,
      'inputs',a.inputs,'versionId',v.id,'versionEffectiveFrom',v.effective_from::text,'versionEffectiveTo',v.effective_to::text,
      'definition',v.definition,'definitionHash',v.definition_hash,
      'components',coalesce((select jsonb_agg(${COMPONENT_SOURCE} order by c.id)
        from pay_components c left join pay_component_earning_classifications ec on ec.org_id=c.org_id and ec.pay_component_id=c.id
        where c.org_id=a.org_id and c.id in (select (rule->>'componentId')::uuid from jsonb_array_elements(v.definition->'rules') rule)), '[]'::jsonb)
    ) as source
    from payroll_compensation_assignments a
    join payroll_compensation_packages p on p.org_id=a.org_id and p.id=a.package_id
    join payroll_compensation_versions v on v.org_id=a.org_id and v.package_id=a.package_id and v.id=a.version_id
    where a.org_id=${orgId} and a.status in ('active','ended') and v.status='approved' and (${predicate})
    order by a.employment_id,a.effective_from,a.id
  `)).rows.map(row => row.source);
}

/** Retirement stops new configuration; approved employment terms continue to govern their covered dates. */
export async function compensationPackageEmploymentSource(tx: SqlExecutor, args: {
  orgId: string; employmentId: string; periodStart: string; periodEnd: string; allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<CompensationPackageAssignmentSource[]> {
  return assignmentSources(tx, args.orgId, sql`a.employment_id=${args.employmentId}
    and a.effective_from<=${args.periodEnd}::date and (a.effective_to is null or a.effective_to>=${args.periodStart}::date)
    ${payrollSubsidiaryScopeFilter(sql`a.subsidiary_id`, args.allowedSubsidiaryIds)}`);
}

/** Reproduce the calculated native employment population, including newly approved terms for those same employments. */
export async function compensationPackageRunSource(tx: SqlExecutor, orgId: string, documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope): Promise<CompensationPackageAssignmentSource[]> {
  return assignmentSources(tx, orgId, sql`exists (
    select 1 from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
    join pay_stubs s on s.org_id=r.org_id and s.pay_run_document_id=r.document_id
    where r.org_id=a.org_id and r.document_id=${documentId} and s.employment_id=a.employment_id
      and s.employee_party_id=a.employee_party_id and d.subsidiary_id=a.subsidiary_id
      and a.effective_from<=r.period_end and (a.effective_to is null or a.effective_to>=r.period_start)
      ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  )`);
}

/** Lock parents before classification rows, including the parent FK fence for a newly inserted classification. */
export async function lockCompensationPackageComponents(tx: SqlExecutor, orgId: string,
  sources: readonly CompensationPackageAssignmentSource[]): Promise<void> {
  const ids = [...new Set(sources.flatMap(source => source.components.map(component => component.id)))].sort();
  if (!ids.length) return;
  const list = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
  const locked = await tx.execute(sql`select id from pay_components where org_id=${orgId} and id in (${list}) order by id for update`);
  if (locked.rows.length !== ids.length) throw new PayrollError('A compensation payroll component is no longer available — reload the package and choose its current native components before recalculating.');
  await tx.execute(sql`select pay_component_id from pay_component_earning_classifications
    where org_id=${orgId} and pay_component_id in (${list}) order by pay_component_id for update`);
}
