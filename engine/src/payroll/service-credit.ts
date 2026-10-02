import { sql } from 'drizzle-orm';
import { addCalendarDays, addMonthsClamped, calendarDaysBetween, isIsoCalendarDate, parseIsoDate } from '../platform/civil-date.ts';
import { db } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { canonicalDecimal } from '../money/exact-decimal.ts';
import { decimalNullRefusal } from '../money/decimal-refusal.ts';
import { PayrollError } from './error.ts';
import { monthsOfService } from './entitlements-service-tiers.ts';

const SCALE = 10n ** 16n;
function units(value: string): bigint {
  if (!/^\d+(?:\.\d{1,16})?$/.test(value)) throw new PayrollError('Credited service must be a nonnegative decimal with at most sixteen decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(16, '0'));
}
function decimal(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % SCALE).toString().padStart(16, '0').replace(/0+$/, '');
  return `${sign}${absolute / SCALE}${fraction ? `.${fraction}` : ''}`;
}
function floorRatio(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value < 0n && value % divisor !== 0n ? quotient - 1n : quotient;
}
export interface ServiceCreditBaseline {
  id: string | null;
  convention: 'calendar_months' | 'actual_365';
  asOfDate: string;
  creditedDays: string | null;
  creditedMonths: number | null;
  sourceSnapshot: Record<string, unknown>;
}
export interface EmploymentServiceCredit {
  convention: ServiceCreditBaseline['convention'];
  serviceDays: string | null;
  completedMonths: number;
  sourceSnapshot: Record<string, unknown>;
}
/** Credit is carried forward from an observed baseline; the original hire date is never rewritten. */
export function computeEmploymentServiceCredit(baseline: ServiceCreditBaseline, asOf: string): EmploymentServiceCredit {
  parseIsoDate(baseline.asOfDate); parseIsoDate(asOf);
  if (baseline.convention === 'calendar_months') {
    if (!Number.isSafeInteger(baseline.creditedMonths) || baseline.creditedMonths! < 0 || baseline.creditedDays !== null) throw new PayrollError('Calendar service requires nonnegative credited months and no credited days.');
    return { convention: baseline.convention, serviceDays: null,
      completedMonths: baseline.creditedMonths! + monthsOfService(baseline.asOfDate, asOf),
      sourceSnapshot: { ...baseline.sourceSnapshot, baselineId: baseline.id, convention: baseline.convention, asOfDate: baseline.asOfDate, creditedMonths: baseline.creditedMonths } };
  }
  if (baseline.convention !== 'actual_365') throw new PayrollError('Select calendar months or ACT/365 as the service convention.');
  if (baseline.creditedDays === null || baseline.creditedMonths !== null) throw new PayrollError('ACT/365 service requires credited days and no credited months.');
  const days = units(baseline.creditedDays) + BigInt(calendarDaysBetween(baseline.asOfDate, asOf)) * SCALE;
  const completedMonths = floorRatio(days * 12n, 365n * SCALE);
  if (completedMonths > BigInt(Number.MAX_SAFE_INTEGER) || completedMonths < BigInt(Number.MIN_SAFE_INTEGER)) throw new PayrollError('Credited service exceeds the supported whole-month range; correct its observed baseline.');
  return { convention: baseline.convention, serviceDays: decimal(days), completedMonths: Number(completedMonths),
    sourceSnapshot: { ...baseline.sourceSnapshot, baselineId: baseline.id, convention: baseline.convention, asOfDate: baseline.asOfDate, creditedDays: baseline.creditedDays } };
}
export function meetsServiceYears(credit: EmploymentServiceCredit, minimumYears: number): boolean {
  if (!Number.isSafeInteger(minimumYears) || minimumYears < 0) throw new PayrollError('A service threshold must be a nonnegative whole number of years.');
  if (credit.convention === 'calendar_months') return credit.completedMonths >= minimumYears * 12;
  if (credit.serviceDays === null) throw new PayrollError('ACT/365 service has no credited-day evidence; record its service baseline.');
  if (credit.serviceDays.startsWith('-')) return false;
  return units(credit.serviceDays) >= BigInt(minimumYears) * 365n * SCALE;
}
export async function resolveEmploymentServiceCredit(executor: Pick<typeof db, 'execute'>, input: { orgId: string; employmentId: string; asOf: string }): Promise<EmploymentServiceCredit | null> {
  parseIsoDate(input.asOf);
  await lockPayrollServiceConfiguration(executor, input.orgId);
  const rows = await executor.execute<Record<string, unknown>>(sql`
    select c.id, c.convention, c.as_of_date, c.credited_days::text, c.credited_months, c.source_snapshot, e.service_start
    from worker_employments e left join payroll_service_credits c on c.org_id = e.org_id and c.employment_id = e.id
      and c.effective_from <= ${input.asOf}::date and (c.effective_to is null or c.effective_to >= ${input.asOf}::date)
    where e.org_id = ${input.orgId} and e.id = ${input.employmentId}
  `);
  const row = rows.rows[0];
  if (!row) throw new PayrollError('The employment is outside this organization or no longer available; select an employment in this organization.');
  if (rows.rows.length !== 1) throw new PayrollError('Service baselines overlap; close the conflicting effective windows before calculating payroll.');
  if (!row.id) {
    if (!row.service_start) return null;
    return computeEmploymentServiceCredit({ id: null, convention: 'calendar_months', asOfDate: String(row.service_start).slice(0, 10), creditedMonths: 0, creditedDays: null, sourceSnapshot: { source: 'employment_service_start' } }, input.asOf);
  }
  return computeEmploymentServiceCredit({ id: String(row.id), convention: row.convention as ServiceCreditBaseline['convention'], asOfDate: String(row.as_of_date).slice(0, 10),
    creditedDays: row.credited_days == null ? null : String(row.credited_days), creditedMonths: row.credited_months == null ? null : Number(row.credited_months),
    sourceSnapshot: row.source_snapshot as Record<string, unknown> }, input.asOf);
}

/** Configuration writers acquire this same transaction lock in their database guard. */
export async function lockPayrollServiceConfiguration(executor: Pick<typeof db, 'execute'>, orgId: string): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'openbooks:payroll-service:' + orgId},0))`);
}

/** First civil date reaching a schedule threshold under the declared convention. */
export function serviceCreditMilestoneDate(baseline: ServiceCreditBaseline, afterMonths: number): string {
  if (!Number.isSafeInteger(afterMonths) || afterMonths < 0) throw new PayrollError('A service threshold must be nonnegative whole months.');
  computeEmploymentServiceCredit(baseline, baseline.asOfDate);
  if (baseline.convention === 'calendar_months') return addMonthsClamped(baseline.asOfDate, afterMonths - baseline.creditedMonths!);
  const offset = -floorRatio(-(BigInt(afterMonths) * 365n * SCALE - units(baseline.creditedDays!) * 12n), 12n * SCALE);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER) || offset < BigInt(Number.MIN_SAFE_INTEGER)) throw new PayrollError('The service milestone exceeds the supported civil-date range; correct its baseline.');
  return addCalendarDays(baseline.asOfDate, Number(offset));
}

/** Native configuration writes validate complete terms, including partial edits. */
export async function validateServiceCreditConfiguration(executor: Pick<typeof db, 'execute'>, orgId: string, body: Record<string, unknown>, rowId?: string): Promise<void> {
  await lockPayrollServiceConfiguration(executor, orgId);
  let stored: Record<string, unknown> = {};
  if (rowId) {
    if (!isUuid(rowId)) throw new PayrollError('Select a saved employee policy before changing its configuration.');
    const result = await executor.execute<Record<string, unknown>>(sql`select * from payroll_service_credits where org_id = ${orgId} and id = ${rowId} for update`);
    if (result.rows.length !== 1) throw new PayrollError('Service credit was not found in this organization; reopen the employee service record.');
    const row = result.rows[0]!;
    stored = { employmentId: row.employment_id, convention: row.convention, asOfDate: row.as_of_date, creditedDays: row.credited_days, creditedMonths: row.credited_months, effectiveFrom: row.effective_from, effectiveTo: row.effective_to, reason: row.reason };
  }
  const values = { ...stored, ...body };
  if (!isIsoCalendarDate(values.asOfDate) || !isIsoCalendarDate(values.effectiveFrom)
    || (values.effectiveTo != null && values.effectiveTo !== '' && (!isIsoCalendarDate(values.effectiveTo) || String(values.effectiveTo) < values.effectiveFrom))) throw new PayrollError('Enter valid credited-service dates with the end on or after the effective start.');
  if (!isUuid(values.employmentId)) throw new PayrollError('Choose a saved employment for credited service.');
  if (typeof values.reason !== 'string' || !values.reason.trim()) throw new PayrollError('Enter the reason for this credited-service baseline.');
  const creditedDays = values.creditedDays == null || values.creditedDays === '' ? null : canonicalDecimal(values.creditedDays, 16);
  if (values.creditedDays != null && values.creditedDays !== '' && creditedDays === null) throw new PayrollError(decimalNullRefusal('creditedDays', 'a credited-day value', values.creditedDays, 16));
  computeEmploymentServiceCredit({ id: rowId ?? null, convention: values.convention as ServiceCreditBaseline['convention'], asOfDate: values.asOfDate,
    creditedDays, creditedMonths: values.creditedMonths == null || values.creditedMonths === '' ? null : values.creditedMonths as number, sourceSnapshot: {} }, values.asOfDate);
  const employment = await executor.execute(sql`select id from worker_employments where org_id = ${orgId} and id = ${values.employmentId}`);
  if (employment.rows.length !== 1) throw new PayrollError('Select an employment in this organization for credited service.');
}
