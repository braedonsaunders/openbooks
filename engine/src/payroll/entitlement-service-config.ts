import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { isIsoCalendarDate } from '../platform/civil-date.ts';
import { isUuid } from '../platform/uuid.ts';
import { canonicalDecimal } from '../money/exact-decimal.ts';
import { decimalNullRefusal, moneyRefusal } from '../money/decimal-refusal.ts';
import { cmp } from '../money/money.ts';
import { PayrollError } from './error.ts';
import { lockPayrollServiceConfiguration } from './service-credit.ts';

/** Validate a complete native schedule, including the stored values of a partial update. */
export async function validateEntitlementServiceTierConfiguration(executor: Pick<typeof db, 'execute'>, orgId: string, body: Record<string, unknown>, rowId?: string): Promise<void> {
  await lockPayrollServiceConfiguration(executor, orgId);
  let stored: Record<string, unknown> = {};
  if (rowId) {
    if (!isUuid(rowId)) throw new PayrollError('Select a saved service tier before changing its schedule.');
    const result = await executor.execute<Record<string, unknown>>(sql`select * from entitlement_service_tiers where org_id=${orgId} and id=${rowId} for update`);
    if (result.rows.length !== 1) throw new PayrollError('Service tier was not found in this organization; reopen its entitlement schedule.');
    stored = Object.fromEntries(Object.entries(result.rows[0]!).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
  }
  const values = { ...stored, ...body };
  const supplied = (value: unknown): boolean => value != null && value !== '';
  const hasPlan = supplied(values.planId);
  const hasComponent = supplied(values.componentId);
  if (hasPlan === hasComponent) throw new PayrollError('Choose exactly one entitlement plan or pay component for this service tier.');
  if (hasPlan && (!supplied(values.accrualValue) || supplied(values.eligible))) throw new PayrollError('A plan tier requires an accrual value; eligibility belongs to a pay-component tier. Select the plan target again to clear component eligibility.');
  if (hasComponent && (typeof values.eligible !== 'boolean' || supplied(values.accrualValue) || supplied(values.annualDays))) throw new PayrollError('A pay-component tier requires an eligibility choice. Accrual values and annual days belong to an entitlement-plan tier; select the component target again to clear them.');
  const months = typeof values.afterMonths === 'number' ? values.afterMonths : typeof values.afterMonths === 'string' && /^\d+$/.test(values.afterMonths) ? Number(values.afterMonths) : NaN;
  if (!Number.isSafeInteger(months) || months < 0 || months > 2147483647) throw new PayrollError('Enter completed service months as a nonnegative whole number no greater than 2147483647.');
  for (const [key, label, digits] of [['accrualValue', 'an accrual value', 15], ['annualDays', 'an annual day allowance', 8]] as const) {
    if (!supplied(values[key])) continue;
    const decimal = canonicalDecimal(values[key], 4);
    if (decimal === null) throw new PayrollError(decimalNullRefusal(key, label, values[key], 4));
    if (decimal.split('.')[0]!.replace(/^[-+]/, '').length > digits) throw new PayrollError(moneyRefusal(key, values[key], label, 4, digits));
    if (cmp(decimal, '0') < 0) throw new PayrollError(`${key === 'annualDays' ? 'Annual days' : 'Accrual value'} cannot be negative; enter a nonnegative value in the plan's stated unit.`);
  }
  if (!isIsoCalendarDate(values.effectiveFrom) || (supplied(values.effectiveTo) && (!isIsoCalendarDate(values.effectiveTo) || String(values.effectiveTo) < String(values.effectiveFrom)))) throw new PayrollError('Enter valid service-tier effective dates with the end on or after the start.');
  if (values.isActive != null && typeof values.isActive !== 'boolean') throw new PayrollError('Choose whether this service tier is active.');
  const target = hasPlan ? values.planId : values.componentId;
  if (!isUuid(target)) throw new PayrollError('Choose a saved entitlement plan or pay component for the service tier.');
  const reference = hasPlan
    ? await executor.execute(sql`select id from entitlement_plans where org_id=${orgId} and id=${String(target)}`)
    : await executor.execute<{ id: string; name: string; system_key: string | null }>(sql`select id,name,system_key from pay_components where org_id=${orgId} and id=${String(target)}`);
  if (reference.rows.length !== 1) throw new PayrollError('Select a service-tier target in this organization.');
  if (hasComponent && (reference.rows[0] as { system_key?: unknown }).system_key != null) throw new PayrollError('Engine-owned payroll components cannot have service gates; choose an employer-defined component instead.');
  if (supplied(values.employerSubsidiaryId)) {
    if (!isUuid(values.employerSubsidiaryId)) throw new PayrollError('Choose a saved legal employer or leave the employer empty for an organization-default schedule.');
    const employer = await executor.execute(sql`select id from subsidiaries where org_id=${orgId} and id=${String(values.employerSubsidiaryId)}`);
    if (employer.rows.length !== 1) throw new PayrollError('Select a legal employer in this organization for the service schedule.');
  }
}
