import { sql } from 'drizzle-orm';
import { db, inExecutorTransaction, withOrgTransaction, type SqlExecutor } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { canonicalJson } from '../platform/canonical-json.ts';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { organizationCurrencyAvailable } from '../organization/currency-options.ts';
import { cmp } from '../money/money.ts';
import { PayrollError } from './error.ts';
import { requirePayrollFeature } from './feature-gate.ts';
import { employeeTaxYearFenceKey, takeEmployeeTaxYearFences } from './fences.ts';
import { OPENING_BALANCE_FIELDS, assertTaxYear } from './opening-balances.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from './scope.ts';
import { nextPeriodAfter, at, iso, DAY, type ScheduleRow } from './run-calendar.ts';
import { resolvePayrollRunContext } from './pack-run-context.ts';
import { assertPeriodOpeningDates, type PayrollPeriodOpeningIdentity } from './period-opening-contract.ts';
import { declaredPeriodOpening, periodOpeningContractHash } from './period-opening-declaration.ts';

export type PayrollPeriodOpeningRecord = { [Key in keyof PayrollPeriodOpeningIdentity]: PayrollPeriodOpeningIdentity[Key] } & {
  id: string; employeePartyId: string; annualOpeningBalanceId: string; revision: number;
  amounts: Record<string, string>; annualBounds: Record<string, string>; contractHash: string;
  sourceReference: string; reason: string; updatedAt: string;
};

const COLUMNS = sql`id,employee_party_id as "employeePartyId",annual_opening_balance_id as "annualOpeningBalanceId",
 subsidiary_id as "subsidiaryId",pay_schedule_id as "payScheduleId",country,currency,tax_year as "taxYear",
 period_start::text as "periodStart",period_end::text as "periodEnd",paid_through::text as "paidThrough",
 amounts,annual_bounds as "annualBounds",contract_hash as "contractHash",revision,
 source_reference as "sourceReference",reason,updated_at::text as "updatedAt"`;

export class PayrollPeriodOpeningUnavailableError extends PayrollError {
  constructor() { super('Same-period opening payments are unavailable on this server — ask an administrator to complete the server upgrade before recording them.'); }
}

function periodOpeningSchemaRefusal(error: unknown): PayrollPeriodOpeningUnavailableError | null {
  const visited = new Set<object>();
  let detail = error;
  while (detail && typeof detail === 'object' && !visited.has(detail)) {
    visited.add(detail);
    const cause = detail as { code?: string; message?: string; cause?: unknown };
    if (cause.code === '42P01' && /^relation "(?:public\.)?payroll_period_openings" does not exist$/.test(cause.message ?? '')) {
      return new PayrollPeriodOpeningUnavailableError();
    }
    detail = cause.cause;
  }
  return null;
}

function reference(value: unknown, label: string): string {
  if (!isUuid(value)) throw new PayrollError(`Choose a valid native ${label} reference before recording period payments`);
  return value;
}
function evidence(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) {
    throw new PayrollError(`${label} requires 1–2000 characters — identify the previous provider's verified payment evidence`);
  }
  return value.trim();
}

/** An explicit command attributes existing annual carry-in; it never writes payment or ledger rows. */
export async function savePayrollPeriodOpening(input: {
  orgId: string; actorId: string; employeePartyId: string; taxYear: number;
  subsidiaryId: string; payScheduleId: string; country: string; currency: string;
  periodStart: string; periodEnd: string; paidThrough: string;
  amounts: unknown; sourceReference: string; reason: string;
  expectedRevision: number | null; expectedAnnualUpdatedAt: string;
  dryRun: boolean; allowedSubsidiaryIds: PayrollSubsidiaryScope;
}, executor?: SqlExecutor): Promise<{ changed: boolean; record: PayrollPeriodOpeningRecord | null; annualUpdatedAt: string }> {
  for (const [label, value] of [['organization', input.orgId], ['actor', input.actorId], ['employee', input.employeePartyId],
    ['legal employer', input.subsidiaryId], ['payroll schedule', input.payScheduleId]]) reference(value, label!);
  const taxYear = assertTaxYear(input.taxYear);
  assertPeriodOpeningDates({ ...input, taxYear });
  if (!/^[A-Z]{2}$/.test(input.country) || !/^[A-Z]{3}$/.test(input.currency)) throw new PayrollError('Choose the payroll country and currency declared by the native employee and legal employer');
  if (input.allowedSubsidiaryIds === undefined || typeof input.dryRun !== 'boolean') throw new PayrollError('Period openings require an explicit legal-entity scope and preview or apply mode');
  if (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) throw new PayrollError('Reload the current period-opening revision before saving');
  if (typeof input.expectedAnnualUpdatedAt !== 'string' || !input.expectedAnnualUpdatedAt.trim()) throw new PayrollError('Load and review the annual opening balance before attributing period payments');
  const sourceReference = evidence(input.sourceReference, 'Source reference');
  const reason = evidence(input.reason, 'Reason');
  const apply = async (tx: SqlExecutor) => {
    if (!await actorHasPermission(tx, input.orgId, input.actorId, 'payroll.manage')) throw new PayrollError('Payroll manage permission is required to record period-opening payments');
    const authority = await lockActorCommandAuthority(tx, input.orgId, input.actorId, input.subsidiaryId, 'payroll.manage');
    await requirePayrollFeature(tx, input.orgId);
    const employee = (await tx.execute<{ id: string; subsidiary_id: string | null }>(sql`
      select p.id,p.subsidiary_id from parties p where p.org_id=${input.orgId} and p.id=${input.employeePartyId}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, authority)} for share`)).rows[0];
    if (!employee || employee.subsidiary_id !== input.subsidiaryId) throw new PayrollError('The employee is not available in that legal employer — review the native employee identity and your legal-entity scope');
    const profile = (await tx.execute<{ country: string; pay_schedule_id: string | null }>(sql`
      select country,pay_schedule_id from employee_payroll_profiles
       where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} for share`)).rows[0];
    if (!profile || profile.country !== input.country) throw new PayrollError('The opening country must match the employee payroll profile — review Payroll → Profiles before saving');
    const subsidiary = (await tx.execute<{ id: string; name: string; country: string | null; baseCurrency: string | null }>(sql`
      select id,name,country,base_currency as "baseCurrency" from subsidiaries where org_id=${input.orgId} and id=${input.subsidiaryId} and is_active for share`)).rows[0];
    if (!subsidiary || !await organizationCurrencyAvailable(tx, input.orgId, input.currency, input.subsidiaryId)) throw new PayrollError('The opening currency is unavailable for the legal employer — review its currency in Company Settings');
    const context = resolvePayrollRunContext({ payDate: input.paidThrough, subsidiary, runCurrency: input.currency });
    if (context.country !== input.country || context.taxYear !== taxYear) throw new PayrollError('The opening country and tax year must match the legal employer and the paid-through date under its payroll pack');
    const quantum = (await tx.execute<{ minor_units: number }>(sql`select minor_units from currencies where code=${input.currency} for share`)).rows[0];
    if (!quantum) throw new PayrollError('The payroll currency is unregistered — review Company Settings → Currencies');
    const schedule = (await tx.execute<ScheduleRow & { subsidiary_id: string | null }>(sql`
      select id,frequency,periods_per_year,anchor_period_end::text as anchor_period_end,pay_date_offset_days,subsidiary_id
       from pay_schedules where org_id=${input.orgId} and id=${input.payScheduleId} and is_active for share`)).rows[0];
    if (!schedule || (schedule.subsidiary_id !== null && schedule.subsidiary_id !== input.subsidiaryId)
      || (profile.pay_schedule_id !== null && profile.pay_schedule_id !== input.payScheduleId)) throw new PayrollError('Choose the active payroll schedule assigned to this employee and legal employer');
    const period = nextPeriodAfter(schedule, iso(new Date(at(input.periodEnd).getTime() - DAY)));
    if (period.periodStart !== input.periodStart || period.periodEnd !== input.periodEnd) throw new PayrollError(`The opening period does not match ${schedule.frequency.replace('_', '-')} schedule boundaries — use ${period.periodStart} through ${period.periodEnd}`);
    await takeEmployeeTaxYearFences(tx, [employeeTaxYearFenceKey(input.orgId, input.employeePartyId, taxYear)]);
    // Read after the same fence used by annual saves and native payroll commits.
    const committed = (await tx.execute<{ document_number: string }>(sql`
      select d.document_number from pay_stubs s join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
       join documents d on d.org_id=r.org_id and d.id=r.document_id
       where s.org_id=${input.orgId} and s.employee_party_id=${input.employeePartyId} and s.tax_year=${taxYear}
        and r.run_status='committed' order by r.pay_date limit 1`)).rows[0];
    if (committed) throw new PayrollError(`Pay run ${committed.document_number} already used this employee's ${taxYear} opening balances — use its controlled void action before correcting carry-in`);
    const annualColumns = sql.join(OPENING_BALANCE_FIELDS.flatMap((field) => [sql`${field.column}::text`, sql`${sql.identifier('b')}.${sql.identifier(field.column)}::text`]), sql`, `);
    const annual = (await tx.execute<{ id: string; updated_at: string; amounts: Record<string, string> }>(sql`
      select b.id,b.updated_at::text as updated_at,jsonb_build_object(${annualColumns}) as amounts from payroll_opening_balances b
       where b.org_id=${input.orgId} and b.employee_party_id=${input.employeePartyId} and b.tax_year=${taxYear} for update`)).rows[0];
    if (!annual) throw new PayrollError('Record the verified annual payroll opening balances before attributing same-period payments');
    if (annual.updated_at !== input.expectedAnnualUpdatedAt) throw new PayrollError('The annual opening balance changed — reload and review both annual and period amounts before saving');
    const current = (await tx.execute<PayrollPeriodOpeningRecord>(sql`select ${COLUMNS} from payroll_period_openings
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and tax_year=${taxYear} for update`)).rows[0] ?? null;
    if ((current?.revision ?? null) !== input.expectedRevision) throw new PayrollError('The period opening changed — reload its current revision and review your source amounts');
    const { payrollPack } = await import('./packs.ts');
    const pack = payrollPack(input.country);
    const treatment = pack.periodOpeningTreatment;
    if (!treatment) throw new PayrollError(`${input.country} does not declare prior-provider period-opening inputs — use a supported payroll pack before admitting same-period payments`);
    const prepared = declaredPeriodOpening({ country: input.country, treatment, amounts: input.amounts, currencyMinorUnits: quantum.minor_units });
    const programRows = (await tx.execute<{ program_key: string; insurable_ytd: string }>(sql`select program_key,insurable_ytd::text as insurable_ytd
      from payroll_opening_program_bases where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and tax_year=${taxYear} for share`)).rows;
    const bounds: Record<string, string> = {};
    for (const [key, value] of Object.entries(prepared.annualBounds)) {
      const field = OPENING_BALANCE_FIELDS.find((candidate) => candidate.key === key && candidate.packs.includes(input.country));
      const program = key.startsWith('program:') ? pack.contributionPrograms?.find((candidate) => `program:${candidate.key}` === key) : undefined;
      if (!field && !program) throw new PayrollError(`${input.country} declares an unavailable annual bound "${key}" — correct its pack declaration before saving`);
      const annualAmount = field ? String(annual.amounts[field.column]) : programRows.find((row) => row.program_key === program!.key)?.insurable_ytd ?? '0';
      if (cmp(value, annualAmount) > 0) throw new PayrollError(`${treatment.annualBounds.find((bound) => bound.annualOpeningKey === key)!.label} (${value}) must already be included in annual opening "${key}" — review Payroll opening balances before admitting the period share`);
      bounds[field?.column ?? key] = value;
    }
    const contractHash = periodOpeningContractHash(treatment);
    const editable = { subsidiaryId: input.subsidiaryId, payScheduleId: input.payScheduleId, country: input.country, currency: input.currency,
      periodStart: input.periodStart, periodEnd: input.periodEnd, paidThrough: input.paidThrough,
      amounts: prepared.amounts, annualBounds: bounds, contractHash, sourceReference, reason };
    if (current && Object.entries(editable).every(([key, value]) => canonicalJson(current[key as keyof PayrollPeriodOpeningRecord]) === canonicalJson(value))) return { changed: false, record: current, annualUpdatedAt: annual.updated_at };
    if (input.dryRun) return { changed: true, record: current, annualUpdatedAt: annual.updated_at };
    const rows = current
      ? (await tx.execute<PayrollPeriodOpeningRecord>(sql`update payroll_period_openings set
        subsidiary_id=${input.subsidiaryId},pay_schedule_id=${input.payScheduleId},country=${input.country},currency=${input.currency},
        period_start=${input.periodStart},period_end=${input.periodEnd},paid_through=${input.paidThrough},
        amounts=${JSON.stringify(prepared.amounts)}::jsonb,annual_bounds=${JSON.stringify(bounds)}::jsonb,contract_hash=${contractHash},
        source_reference=${sourceReference},reason=${reason},revision=revision+1,updated_by=${input.actorId},
        updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
        where org_id=${input.orgId} and id=${current.id} and revision=${input.expectedRevision} returning ${COLUMNS}`)).rows
      : (await tx.execute<PayrollPeriodOpeningRecord>(sql`insert into payroll_period_openings
        (org_id,employee_party_id,annual_opening_balance_id,subsidiary_id,pay_schedule_id,country,currency,tax_year,
         period_start,period_end,paid_through,amounts,annual_bounds,contract_hash,source_reference,reason,created_by,updated_by)
        values (${input.orgId},${input.employeePartyId},${annual.id},${input.subsidiaryId},${input.payScheduleId},${input.country},${input.currency},${taxYear},
         ${input.periodStart},${input.periodEnd},${input.paidThrough},${JSON.stringify(prepared.amounts)}::jsonb,${JSON.stringify(bounds)}::jsonb,${contractHash},
         ${sourceReference},${reason},${input.actorId},${input.actorId}) returning ${COLUMNS}`)).rows;
    if (rows.length !== 1) throw new PayrollError('The period opening was not saved — reload its current revision and retry');
    const updatedAnnual = (await tx.execute<{ updated_at: string }>(sql`select updated_at::text as updated_at from payroll_opening_balances
      where org_id=${input.orgId} and id=${annual.id}`)).rows;
    if (updatedAnnual.length !== 1) throw new PayrollError('The annual opening is unavailable — reload opening balances before saving');
    return { changed: true, record: rows[0]!, annualUpdatedAt: updatedAnnual[0]!.updated_at };
  };
  try { return executor ? await inExecutorTransaction(executor, apply) : await withOrgTransaction(input.orgId, () => apply(db)); }
  catch (error) { throw periodOpeningSchemaRefusal(error) ?? error; }
}
