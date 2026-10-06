import { sql } from 'drizzle-orm';
import { db, withOrgTransaction } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { organizationCurrencyOptions } from '../organization/currency-options.ts';
import { PayrollError } from './error.ts';
import { requirePayrollFeature } from './feature-gate.ts';
import { assertTaxYear } from './opening-balances.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from './scope.ts';
import { PayrollPeriodOpeningUnavailableError, type PayrollPeriodOpeningRecord } from './period-opening-store.ts';
import type { PayrollPeriodOpeningField } from './period-opening-contract.ts';

export interface PayrollPeriodOpeningView {
  employeePartyId: string;
  subsidiaryId: string;
  employerName: string;
  country: string;
  baseCurrency: string;
  assignedScheduleId: string | null;
  annualUpdatedAt: string | null;
  fields: PayrollPeriodOpeningField[];
  currencies: { value: string; label: string }[];
  schedules: { id: string; name: string }[];
  record: PayrollPeriodOpeningRecord | null;
}

/** Employee-scoped payroll evidence; permission and entity scope apply to every transport. */
export async function payrollPeriodOpeningForEmployee(input: {
  orgId: string; actorId: string; employeePartyId: string; taxYear: number;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
}): Promise<PayrollPeriodOpeningView> {
  if (![input.orgId, input.actorId, input.employeePartyId].every(isUuid) || input.allowedSubsidiaryIds === undefined) {
    throw new PayrollError('Choose a native employee and an explicit legal-entity scope before reviewing period payments');
  }
  const year = assertTaxYear(input.taxYear);
  return withOrgTransaction(input.orgId, async () => {
    if (!await actorHasPermission(db, input.orgId, input.actorId, 'payroll.read')) {
      throw new PayrollError('Payroll read permission is required to review period-opening payments');
    }
    await requirePayrollFeature(db, input.orgId);
    const employee = (await db.execute<{
      subsidiaryId: string | null; country: string; assignedScheduleId: string | null;
    }>(sql`select p.subsidiary_id as "subsidiaryId",ep.country,ep.pay_schedule_id as "assignedScheduleId"
      from parties p join employee_payroll_profiles ep on ep.org_id=p.org_id and ep.employee_party_id=p.id
      where p.org_id=${input.orgId} and p.id=${input.employeePartyId}
      ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}`)).rows[0];
    if (!employee) throw new PayrollError('The employee is unavailable in your payroll scope — return to the employee list');
    if (!employee.subsidiaryId) throw new PayrollError('Assign the employee to its native legal employer before recording period payments');
    const authority = await lockActorCommandAuthority(db, input.orgId, input.actorId, employee.subsidiaryId, 'payroll.read');
    const employer = (await db.execute<{ name: string; currency: string | null }>(sql`
      select s.name,s.base_currency as currency from subsidiaries s
      where s.org_id=${input.orgId} and s.id=${employee.subsidiaryId} and s.is_active
      ${payrollSubsidiaryScopeFilter(sql`s.id`, authority)}`)).rows[0];
    if (!employer?.currency) throw new PayrollError('Configure the active legal employer and its payroll currency in Company Settings');
    const available = (await db.execute<{ available: boolean }>(sql`
      select to_regclass('public.payroll_period_openings') is not null as available`)).rows[0]?.available;
    if (!available) throw new PayrollPeriodOpeningUnavailableError();
    const { payrollPack } = await import('./packs.ts');
    const treatment = payrollPack(employee.country).periodOpeningTreatment;
    if (!treatment) throw new PayrollError(`${employee.country} does not support prior-provider period payments — annual opening balances remain available in the Year-to-date tab`);
    const record = (await db.execute<PayrollPeriodOpeningRecord>(sql`
      select id,employee_party_id as "employeePartyId",annual_opening_balance_id as "annualOpeningBalanceId",
        subsidiary_id as "subsidiaryId",pay_schedule_id as "payScheduleId",country,currency,tax_year as "taxYear",
        period_start::text as "periodStart",period_end::text as "periodEnd",paid_through::text as "paidThrough",
        amounts,annual_bounds as "annualBounds",contract_hash as "contractHash",revision,
        source_reference as "sourceReference",reason,updated_at::text as "updatedAt"
      from payroll_period_openings where org_id=${input.orgId}
        and employee_party_id=${input.employeePartyId} and tax_year=${year}`)).rows[0] ?? null;
    const annual = (await db.execute<{ updatedAt: string }>(sql`
      select updated_at::text as "updatedAt" from payroll_opening_balances
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and tax_year=${year}`)).rows[0];
    const schedules = (await db.execute<{ id: string; name: string }>(sql`
      select id,name from pay_schedules where org_id=${input.orgId} and is_active
        and (subsidiary_id is null or subsidiary_id=${employee.subsidiaryId})
        and (${employee.assignedScheduleId}::uuid is null or id=${employee.assignedScheduleId}::uuid)
      order by name,id`)).rows;
    const currencies = (await organizationCurrencyOptions(db, input.orgId, new Set([employee.subsidiaryId])))
      .filter(option => option.scopeValue === null || option.scopeValue === employee.subsidiaryId)
      .map(({ value, label }) => ({ value, label }));
    return { employeePartyId: input.employeePartyId, subsidiaryId: employee.subsidiaryId,
      employerName: employer.name, country: employee.country, baseCurrency: employer.currency,
      assignedScheduleId: employee.assignedScheduleId, annualUpdatedAt: annual?.updatedAt ?? null,
      fields: [...treatment.fields], currencies, schedules, record };
  });
}
