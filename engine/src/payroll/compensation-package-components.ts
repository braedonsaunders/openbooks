import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../platform/db.ts';
import type { payComponents } from '@openbooks/schema';
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

export const COMPENSATION_PACKAGE_COMPONENT_SOURCE = sql`jsonb_build_object(
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

/** Exact native metadata shared by authoring, preview and calculation. */
export async function compensationPackageComponentSources(tx: SqlExecutor, orgId: string, ids: readonly string[]): Promise<CompensationPackageComponentSource[]> {
  if (!ids.length) return [];
  return (await tx.execute<{ source: CompensationPackageComponentSource }>(sql`select ${COMPENSATION_PACKAGE_COMPONENT_SOURCE} as source
    from pay_components c left join pay_component_earning_classifications ec on ec.org_id=c.org_id and ec.pay_component_id=c.id
    where c.org_id=${orgId} and c.id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}) order by c.id for share of c`)).rows.map(row => row.source);
}

/** Lock parents before classification rows, including the parent FK fence for a newly inserted classification. */
export async function lockCompensationPackageComponents(tx: SqlExecutor, orgId: string,
  sources: readonly { readonly components: readonly CompensationPackageComponentSource[] }[]): Promise<void> {
  const ids = [...new Set(sources.flatMap(source => source.components.map(component => component.id)))].sort();
  if (!ids.length) return;
  const list = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
  const locked = await tx.execute(sql`select id from pay_components where org_id=${orgId} and id in (${list}) order by id for update`);
  if (locked.rows.length !== ids.length) throw new PayrollError('A compensation payroll component is no longer available — reload the package and choose its current native components before recalculating.');
  await tx.execute(sql`select pay_component_id from pay_component_earning_classifications
    where org_id=${orgId} and pay_component_id in (${list}) order by pay_component_id for update`);
}
