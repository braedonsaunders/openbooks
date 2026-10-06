import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../platform/db.ts';
import { canonicalJson } from '../platform/canonical-json.ts';
import { cmp } from '../money/money.ts';
import { PayrollError } from './error.ts';
import { OPENING_BALANCE_FIELDS } from './opening-balances.ts';
import { assertAnnualPeriodOpeningBounds } from './period-opening-bounds.ts';
import { declaredPeriodOpening, periodOpeningContractHash } from './period-opening-declaration.ts';
import { periodOpeningAppliesToRun, periodOpeningPriors, type PayrollPeriodOpeningIdentity } from './period-opening-contract.ts';
import type { PayrollPeriodOpeningRecord } from './period-opening-store.ts';
import type { PayPeriodPriors } from './period-priors.ts';
import type { PayrollCountryPack } from './pack-types.ts';

/** Only explicitly admitted payments feed payroll; comparison registers are never queried. */
export async function payrollPeriodOpeningPriors(tx: SqlExecutor, input: {
  orgId: string; employeePartyIds: readonly string[]; pack: PayrollCountryPack;
  run: Omit<PayrollPeriodOpeningIdentity, 'paidThrough'> & { payDate: string; label: string };
  periodic: boolean;
}): Promise<Map<string, PayPeriodPriors>> {
  const result = new Map<string, PayPeriodPriors>();
  const available = (await tx.execute<{ available: boolean }>(sql`select to_regclass('public.payroll_period_openings') is not null as available`)).rows[0]?.available;
  // No provider period payments can have been admitted on a pre-rollout schema.
  if (!available || !input.employeePartyIds.length) return result;
  const columns = sql.join(OPENING_BALANCE_FIELDS.flatMap((field) => [sql`${field.column}::text`, sql`${sql.identifier('b')}.${sql.identifier(field.column)}::text`]), sql`, `);
  const rows = (await tx.execute<{
    record: PayrollPeriodOpeningRecord; employee_name: string; annual_columns: Record<string, string>;
    programs: Record<string, string>; minor_units: number; annual_id: string | null;
  }>(sql`select jsonb_build_object('id',o.id,'employeePartyId',o.employee_party_id,'annualOpeningBalanceId',o.annual_opening_balance_id,
      'subsidiaryId',o.subsidiary_id,'payScheduleId',o.pay_schedule_id,'country',o.country,'currency',o.currency,'taxYear',o.tax_year,
      'periodStart',o.period_start::text,'periodEnd',o.period_end::text,'paidThrough',o.paid_through::text,
      'amounts',o.amounts,'annualBounds',o.annual_bounds,'contractHash',o.contract_hash,'revision',o.revision,
      'sourceReference',o.source_reference,'reason',o.reason,'updatedAt',o.updated_at::text) as record,
     p.display_name as employee_name,b.id as annual_id,jsonb_build_object(${columns}) as annual_columns,c.minor_units,
     coalesce((select jsonb_object_agg(pb.program_key,pb.insurable_ytd::text) from payroll_opening_program_bases pb
       where pb.org_id=o.org_id and pb.employee_party_id=o.employee_party_id and pb.tax_year=o.tax_year),'{}'::jsonb) as programs
    from payroll_period_openings o join parties p on p.org_id=o.org_id and p.id=o.employee_party_id
    left join payroll_opening_balances b on b.org_id=o.org_id and b.id=o.annual_opening_balance_id
    left join currencies c on c.code=o.currency
    where o.org_id=${input.orgId} and o.tax_year=${input.run.taxYear}
     and o.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(input.employeePartyIds)}::jsonb)::uuid)
    order by o.employee_party_id`)).rows;
  for (const row of rows) {
    try {
      const opening = row.record;
      if (!row.annual_id) throw new PayrollError('The referenced annual opening is unavailable — review Payroll opening balances before calculating');
      const treatment = input.pack.periodOpeningTreatment;
      if (!treatment || opening.contractHash !== periodOpeningContractHash(treatment)) throw new PayrollError('The payroll pack period-opening contract changed or is unavailable — review and save the unused opening under the current pack before calculating');
      const prepared = declaredPeriodOpening({ country: opening.country, treatment, amounts: opening.amounts, currencyMinorUnits: row.minor_units });
      const bounds: Record<string, string> = {};
      for (const [key, value] of Object.entries(prepared.annualBounds)) {
        const field = OPENING_BALANCE_FIELDS.find((candidate) => candidate.key === key && candidate.packs.includes(opening.country));
        const program = key.startsWith('program:') ? input.pack.contributionPrograms?.find((candidate) => `program:${candidate.key}` === key) : undefined;
        if (!field && !program) throw new PayrollError('The period opening names an unavailable annual input — correct its payroll pack declaration');
        bounds[field?.column ?? key] = value;
      }
      if (canonicalJson(bounds) !== canonicalJson(opening.annualBounds)) throw new PayrollError('The period amounts no longer match their admitted annual bounds — review and save the unused opening before calculating');
      assertAnnualPeriodOpeningBounds({ bounds, annualColumns: row.annual_columns, programs: row.programs,
        columnLabels: Object.fromEntries(OPENING_BALANCE_FIELDS.map((field) => [field.column, field.label])) });
      if (periodOpeningAppliesToRun(opening, input.run) && input.periodic && Object.values(prepared.amounts).some((amount) => cmp(amount, '0') !== 0)) {
        result.set(opening.employeePartyId, periodOpeningPriors(treatment.fields, prepared.amounts));
      }
    } catch (error) {
      if (error instanceof PayrollError) throw new PayrollError(`${row.employee_name}: ${error.message}`);
      throw error;
    }
  }
  return result;
}
