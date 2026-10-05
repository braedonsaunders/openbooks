import { canonicalDecimal } from '../money/exact-decimal.ts';
import { decimalNullRefusal } from '../money/decimal-refusal.ts';
import { add, cmp, normalizeMoney, roundMoney, wholeDigits } from '../money/money.ts';
import { isIsoCalendarDate } from '../platform/business-date.ts';
import { PayrollError } from './error.ts';
import type { PayPeriodPriors } from './period-priors.ts';

/** Pack-owned mappings for a paid period share already included in annual carry-in. */
export interface PayrollPeriodOpeningField {
  key: string;
  label: string;
  annualOpeningKey?: string;
  basis?: 'pensionable' | 'insurable';
  factorKey?: string;
  withheldSystemKey?: string;
  /** Withheld and paid amounts must be representable in the registered currency. */
  payable: boolean;
}

export interface PayrollPeriodOpeningDates {
  taxYear: number;
  periodStart: string;
  periodEnd: string;
  paidThrough: string;
}

export function assertPeriodOpeningDates(input: PayrollPeriodOpeningDates): void {
  if (!Number.isInteger(input.taxYear) || input.taxYear < 1900 || input.taxYear > 9999) {
    throw new PayrollError('Use a four-digit tax year from 1900 through 9999 for the period opening');
  }
  for (const [label, value] of [['Period start', input.periodStart], ['Period end', input.periodEnd], ['Paid through', input.paidThrough]]) {
    if (typeof value !== 'string' || !isIsoCalendarDate(value)) {
      throw new PayrollError(`${label} must be a real calendar date in YYYY-MM-DD format`);
    }
  }
  if (input.periodStart > input.periodEnd) {
    throw new PayrollError('Period end must be on or after period start');
  }
  if (input.paidThrough < input.periodEnd || Number(input.paidThrough.slice(0, 4)) !== input.taxYear) {
    throw new PayrollError('Paid through must be on or after period end and within the opening tax year');
  }
}

/** Unknown and missing amounts refuse; an absent source value is never an inferred zero. */
export function normalizePeriodOpeningAmounts(input: {
  country: string;
  fields: readonly PayrollPeriodOpeningField[];
  amounts: unknown;
  currencyMinorUnits: number;
}): Record<string, string> {
  if (!input.fields.length) {
    throw new PayrollError(`${input.country} does not declare prior-provider period-opening inputs`);
  }
  if (!Number.isInteger(input.currencyMinorUnits) || input.currencyMinorUnits < 0 || input.currencyMinorUnits > 4) {
    throw new PayrollError('Period openings require the currency precision registered in Company Settings');
  }
  if (!input.amounts || typeof input.amounts !== 'object' || Array.isArray(input.amounts)) {
    throw new PayrollError('Provide the declared period-opening amounts as decimal text, including explicit zeros');
  }
  const raw = input.amounts as Record<string, unknown>;
  const declared = new Map(input.fields.map((field) => [field.key, field]));
  if (declared.size !== input.fields.length) {
    throw new PayrollError(`${input.country} declares a period-opening input more than once — correct its pack declaration`);
  }
  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) throw new PayrollError(`Period-opening input "${key}" is not declared by ${input.country} — use that pack's input fields`);
  }
  const amounts: Record<string, string> = {};
  for (const field of input.fields) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field.key) || ['constructor', 'prototype'].includes(field.key)
      || typeof field.payable !== 'boolean'
      || ![undefined, 'pensionable', 'insurable'].includes(field.basis)
      || !(field.basis || field.factorKey || field.withheldSystemKey)
      || [field.factorKey, field.withheldSystemKey].some((key) => key !== undefined
        && (!/^[A-Za-z][A-Za-z0-9_:]*$/.test(key) || ['constructor', 'prototype'].includes(key)))) {
      throw new PayrollError(`${input.country} has an invalid period-opening field declaration — correct its pack declaration`);
    }
    if (!Object.hasOwn(raw, field.key) || raw[field.key] === undefined || raw[field.key] === null || raw[field.key] === '') {
      throw new PayrollError(`${field.label} is missing — enter the verified amount, or an explicit 0 when none was paid`);
    }
    const value = canonicalDecimal(raw[field.key], 4);
    if (value === null) {
      throw new PayrollError(decimalNullRefusal(field.label, 'a decimal amount', raw[field.key], 4));
    }
    if (cmp(value, '0') < 0 || wholeDigits(value) > 15) {
      throw new PayrollError(`${field.label} must be a non-negative amount within the payroll money limit`);
    }
    if (field.payable && cmp(value, roundMoney(value, input.currencyMinorUnits)) !== 0) {
      throw new PayrollError(`${field.label} must use the registered currency's ${input.currencyMinorUnits} decimal places — enter the amount actually paid`);
    }
    amounts[field.key] = normalizeMoney(value);
  }
  return amounts;
}

/**
 * Annual carry-in includes this period share; it is not added a second time.
 * Fields mapped to one annual key are disjoint shares and are bounded together.
 */
export function assertPeriodOpeningAnnualBounds(input: {
  fields: readonly PayrollPeriodOpeningField[];
  amounts: Readonly<Record<string, string>>;
  annualAmounts: Readonly<Record<string, string>>;
}): void {
  const totals = new Map<string, { amount: string; labels: string[] }>();
  for (const field of input.fields) {
    if (!field.annualOpeningKey) continue;
    const prior = totals.get(field.annualOpeningKey) ?? { amount: '0', labels: [] };
    totals.set(field.annualOpeningKey, { amount: add(prior.amount, input.amounts[field.key]!), labels: [...prior.labels, field.label] });
  }
  for (const [annualKey, total] of totals) {
    const annual = canonicalDecimal(input.annualAmounts[annualKey], 4);
    if (annual === null || cmp(annual, '0') < 0 || cmp(total.amount, annual) > 0) {
      throw new PayrollError(`${total.labels.join(' + ')} (${total.amount}) must be included in annual opening "${annualKey}" — review Payroll opening balances before admitting the period share`);
    }
  }
}

/** Convert only the pack's declared inputs into the existing period-prior contract. */
export function periodOpeningPriors(
  fields: readonly PayrollPeriodOpeningField[],
  amounts: Readonly<Record<string, string>>,
): PayPeriodPriors {
  const priors: PayPeriodPriors = { pensionable: '0', insurable: '0', factors: {}, withheldBySystemKey: {} };
  for (const field of fields) {
    const amount = amounts[field.key];
    if (amount === undefined) throw new PayrollError(`${field.label} is missing from the period opening — review its source amounts`);
    if (field.basis) priors[field.basis] = add(priors[field.basis], amount);
    if (field.factorKey) priors.factors[field.factorKey] = add(priors.factors[field.factorKey] ?? '0', amount);
    if (field.withheldSystemKey) priors.withheldBySystemKey[field.withheldSystemKey] = add(priors.withheldBySystemKey[field.withheldSystemKey] ?? '0', amount);
  }
  return priors;
}

export function mergePeriodOpeningPriors(native: PayPeriodPriors, opening: PayPeriodPriors): PayPeriodPriors {
  const merged: PayPeriodPriors = {
    pensionable: add(native.pensionable, opening.pensionable),
    insurable: add(native.insurable, opening.insurable),
    factors: { ...native.factors }, withheldBySystemKey: { ...native.withheldBySystemKey },
  };
  for (const [key, value] of Object.entries(opening.factors)) merged.factors[key] = add(merged.factors[key] ?? '0', value);
  for (const [key, value] of Object.entries(opening.withheldBySystemKey)) merged.withheldBySystemKey[key] = add(merged.withheldBySystemKey[key] ?? '0', value);
  return merged;
}

export interface PayrollPeriodOpeningIdentity extends PayrollPeriodOpeningDates {
  payScheduleId: string;
  country: string;
  currency: string;
  subsidiaryId: string;
}

/** A prior-provider cutover cannot be consumed as another employer's or period's pay. */
export function periodOpeningAppliesToRun(
  opening: PayrollPeriodOpeningIdentity,
  run: Omit<PayrollPeriodOpeningIdentity, 'paidThrough'> & { payDate: string; label: string },
): boolean {
  assertPeriodOpeningDates(opening);
  if (!isIsoCalendarDate(run.payDate) || !isIsoCalendarDate(run.periodStart) || !isIsoCalendarDate(run.periodEnd) || run.periodStart > run.periodEnd) {
    throw new PayrollError(`Pay run ${run.label} has an invalid date range — review its payroll period and pay date`);
  }
  if (run.taxYear !== opening.taxYear || Number(run.payDate.slice(0, 4)) !== run.taxYear) {
    throw new PayrollError(`Pay run ${run.label} and the period opening must use the same pay-date tax year`);
  }
  if (run.country !== opening.country || run.currency !== opening.currency || run.subsidiaryId !== opening.subsidiaryId) {
    throw new PayrollError(`Pay run ${run.label} does not match the period opening's country, currency or legal employer — review the employee's opening balances and payroll scope`);
  }
  if (run.payDate <= opening.paidThrough) {
    throw new PayrollError(`Pay run ${run.label} is paid on or before the prior-provider paid-through date ${opening.paidThrough} — review the cutover before counting those payments again`);
  }
  const overlaps = run.periodStart <= opening.periodEnd && run.periodEnd >= opening.periodStart;
  if (!overlaps) return false;
  if (run.payScheduleId !== opening.payScheduleId || run.periodStart !== opening.periodStart || run.periodEnd !== opening.periodEnd) {
    throw new PayrollError(`Pay run ${run.label} overlaps a prior-provider period opening on a different schedule or date range — use the opening's payroll schedule and exact period`);
  }
  return true;
}
