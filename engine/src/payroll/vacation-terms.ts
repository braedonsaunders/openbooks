import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { isIsoCalendarDate } from '../platform/civil-date.ts';
import { isUuid } from '../platform/uuid.ts';
import { decimalNullRefusal, moneyRefusal } from '../money/decimal-refusal.ts';
import { canonicalDecimal } from '../money/exact-decimal.ts';
import { cmp, wholeDigits } from '../money/money.ts';
import { PayrollError } from './error.ts';
import { lockPayrollServiceConfiguration } from './service-credit.ts';

export type VacationMethod = 'accrue' | 'pay_each_period' | 'paid_leave';
export interface VacationTerms {
  id: string;
  employmentId: string;
  planId: string;
  method: VacationMethod;
  percentFloor: string | null;
  annualDaysFloor: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceSnapshot: Record<string, unknown>;
}
/** Vacation elections belong to the employment, independently of tax and banking setup. */
export async function resolveVacationTerms(executor: Pick<typeof db, 'execute'>, orgId: string, employmentId: string, onDate: string): Promise<VacationTerms | null> {
  if (!isIsoCalendarDate(onDate)) throw new PayrollError('Select a valid civil date to resolve vacation terms.');
  await lockPayrollServiceConfiguration(executor, orgId);
  const result = await executor.execute<Record<string, unknown>>(sql`
    select id, employment_id, plan_id, method, percent_floor::text, annual_days_floor::text, effective_from, effective_to, source_snapshot
    from payroll_vacation_terms where org_id = ${orgId} and employment_id = ${employmentId}
      and effective_from <= ${onDate}::date and (effective_to is null or effective_to >= ${onDate}::date)
  `);
  if (result.rows.length > 1) throw new PayrollError('Vacation terms overlap; close the conflicting effective windows before calculating payroll.');
  const row = result.rows[0];
  if (row) {
    const plan = await executor.execute(sql`select id from entitlement_plans where org_id=${orgId} and id=${String(row.plan_id)}::uuid and system_key='vacation'`);
    if (plan.rows.length !== 1) throw new PayrollError('Employee vacation terms have no governing vacation program; correct their program assignment in Benefits before calculating payroll.');
  }
  return row ? { id: String(row.id), employmentId: String(row.employment_id), planId: String(row.plan_id), method: row.method as VacationMethod,
    percentFloor: row.percent_floor == null ? null : String(row.percent_floor), annualDaysFloor: row.annual_days_floor == null ? null : String(row.annual_days_floor),
    effectiveFrom: String(row.effective_from).slice(0, 10), effectiveTo: row.effective_to == null ? null : String(row.effective_to).slice(0, 10), sourceSnapshot: row.source_snapshot as Record<string, unknown> } : null;
}
/** Shared native writer guard; partial updates validate their complete stored configuration. */
export async function validateVacationTermConfiguration(executor: Pick<typeof db, 'execute'>, orgId: string, body: Record<string, unknown>, rowId?: string): Promise<void> {
  await lockPayrollServiceConfiguration(executor, orgId);
  let stored: Record<string, unknown> = {};
  if (rowId) {
    if (!isUuid(rowId)) throw new PayrollError('Select a saved employee policy before changing its configuration.');
    const result = await executor.execute<Record<string, unknown>>(sql`select * from payroll_vacation_terms where org_id = ${orgId} and id = ${rowId} for update`);
    if (result.rows.length !== 1) throw new PayrollError('Vacation terms were not found in this organization; reopen the employee vacation record.');
    const row = result.rows[0]!;
    stored = { employmentId: row.employment_id, planId: row.plan_id, method: row.method, percentFloor: row.percent_floor, annualDaysFloor: row.annual_days_floor, effectiveFrom: row.effective_from, effectiveTo: row.effective_to, reason: row.reason };
  }
  const values = { ...stored, ...body };
  if (!isUuid(values.planId)) throw new PayrollError('Choose the governing vacation program in Benefits before saving employee vacation terms.');
  const plan = await executor.execute(sql`select id from entitlement_plans where org_id=${orgId} and id=${String(values.planId)}::uuid and system_key='vacation'`);
  if (plan.rows.length !== 1) throw new PayrollError('Select this organization\'s vacation program for employee vacation terms.');
  if (stored.planId != null && values.planId !== stored.planId) throw new PayrollError('Employee vacation program ownership is immutable; create effective-dated successor terms.');
  if (!['accrue','pay_each_period','paid_leave'].includes(String(values.method))) throw new PayrollError('Choose accrue, pay each period, or paid leave for the vacation method.');
  for (const key of ['percentFloor','annualDaysFloor']) {
    if (values[key] != null && values[key] !== '') {
      const value = canonicalDecimal(values[key], 4);
      if (value === null) throw new PayrollError(decimalNullRefusal(key, key === 'percentFloor' ? 'a percentage' : 'an annual day allowance', values[key], 4));
      const maximumDigits = key === 'percentFloor' ? 3 : 8;
      if (wholeDigits(value) > maximumDigits) throw new PayrollError(moneyRefusal(key, values[key], key === 'percentFloor' ? 'a percentage' : 'an annual day allowance', 4, maximumDigits));
      if (cmp(value, '0') < 0) throw new PayrollError(`${key} cannot be negative; enter a nonnegative value.`);
    }
  }
  if (values.method === 'paid_leave' && values.percentFloor != null && values.percentFloor !== '' && cmp(String(values.percentFloor), '0') !== 0) throw new PayrollError('Paid leave keeps salary running; use a zero or empty vacation percentage and enter annual days separately.');
  if (!isIsoCalendarDate(values.effectiveFrom) || (values.effectiveTo != null && values.effectiveTo !== '' && (!isIsoCalendarDate(values.effectiveTo) || String(values.effectiveTo) < String(values.effectiveFrom)))) throw new PayrollError('Enter valid vacation effective dates with the end on or after the start.');
  if (typeof values.reason !== 'string' || values.reason.trim() === '') throw new PayrollError('Enter a reason for these employee vacation terms.');
  if (!isUuid(values.employmentId)) throw new PayrollError('Choose a saved employment for vacation terms.');
  const employment = await executor.execute(sql`select id from worker_employments where org_id = ${orgId} and id = ${String(values.employmentId)}`);
  if (employment.rows.length !== 1) throw new PayrollError('Select an employment in this organization for vacation terms.');
}
