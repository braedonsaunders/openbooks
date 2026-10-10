import { canonicalDecimal } from '../money/exact-decimal.ts';
import { add, normalizeMoney } from '../money/money.ts';
import { addCalendarDays, calendarDaysBetween } from '../platform/business-date.ts';
import { isIsoCalendarDate } from '../platform/iso-date.ts';
import { PayrollError } from './error.ts';

export const PRIOR_EARNING_BUCKETS = ['regular', 'overtime', 'vacationPay', 'holidayPay'] as const;
export type PriorEarningBucket = typeof PRIOR_EARNING_BUCKETS[number];
export interface PriorEarningLine {
  sourceKey: string;
  sourceLabel: string;
  earnedFrom: string;
  earnedThrough: string;
  bucket: PriorEarningBucket;
  amount: string;
}
export interface PriorEarningsPeriod {
  from: string;
  through: string;
  sourceReference: string;
  /** An empty set expressly records a source-confirmed period without earnings. */
  lines: PriorEarningLine[];
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PayrollError('Prior earnings must contain named period and earning fields');
  return value as Record<string, unknown>;
};
export function priorEarningsEvidence(value: unknown, label: string, limit = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new PayrollError(`${label} requires 1–${limit} characters identifying the verified previous payroll source`);
  return value.trim();
}
function day(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isIsoCalendarDate(value)) throw new PayrollError(`${label} must be a real ISO calendar date`);
  return value;
}

/** Complete dated coverage is explicit; absent weeks never become zero earnings. */
export function preparePriorEarnings(input: { historyFrom: string; historyThrough: string; periods: unknown }): PriorEarningsPeriod[] {
  const from = day(input.historyFrom, 'Prior earnings start');
  const through = day(input.historyThrough, 'Prior earnings end');
  if (through < from || calendarDaysBetween(from, through) > 366) throw new PayrollError('Prior earnings must cover an ordered interval of at most 367 days');
  if (!Array.isArray(input.periods) || input.periods.length < 1 || input.periods.length > 367) throw new PayrollError('Supply every source period in the prior-earnings interval, including source-confirmed periods without earnings');
  const keys = new Set<string>();
  const periods = input.periods.map((value): PriorEarningsPeriod => {
    const period = record(value);
    const start = day(period.from, 'Source period start');
    const end = day(period.through, 'Source period end');
    if (start < from || end > through || end < start) throw new PayrollError('Each prior-earnings period must lie wholly inside its declared history interval');
    if (!Array.isArray(period.lines) || period.lines.length > 2000) throw new PayrollError('Each source period requires its explicit earning lines or an empty set for confirmed zero earnings');
    const lines = period.lines.map((value): PriorEarningLine => {
      const line = record(value);
      const sourceKey = priorEarningsEvidence(line.sourceKey, 'Earning source key', 300);
      if (keys.has(sourceKey)) throw new PayrollError(`Prior earning source ${sourceKey} is repeated — retain duplicate source copies as evidence without counting the earning again`);
      keys.add(sourceKey);
      const earnedFrom = day(line.earnedFrom, 'Earning start');
      const earnedThrough = day(line.earnedThrough, 'Earning end');
      if (earnedFrom < start || earnedThrough > end || earnedThrough < earnedFrom) throw new PayrollError('Prior earnings require their actual earned dates within the source period; payment dates do not establish when wages were earned');
      if (!PRIOR_EARNING_BUCKETS.includes(line.bucket as PriorEarningBucket)) throw new PayrollError('Classify each prior earning as regular wages, overtime, vacation pay payable for its earned dates, or public-holiday pay');
      const amount = canonicalDecimal(line.amount, 4);
      if (amount === null || amount.replace(/^-/, '').split('.')[0]!.length > 15) throw new PayrollError('Prior earning amounts require exact decimal text with at most four fractional places and fifteen whole digits');
      return { sourceKey, sourceLabel: priorEarningsEvidence(line.sourceLabel, 'Original earning category', 160), earnedFrom, earnedThrough, bucket: line.bucket as PriorEarningBucket, amount: normalizeMoney(amount) };
    });
    return { from: start, through: end, sourceReference: priorEarningsEvidence(period.sourceReference, 'Source period reference'), lines };
  }).sort((a, b) => a.from.localeCompare(b.from));
  let next = from;
  for (const period of periods) {
    if (period.from !== next) throw new PayrollError(`Prior earnings contain a gap or overlapping period at ${next} — supply its original source or an explicit source-confirmed zero period`);
    next = addCalendarDays(period.through, 1);
  }
  if (periods.at(-1)!.through !== through) throw new PayrollError('Prior earnings do not reach the declared history end — supply every remaining source period');
  return periods;
}

/** Cross-boundary amounts require dated source splits, never calendar proration. */
export function priorEarningsInWindow(periods: readonly PriorEarningsPeriod[], window: { from: string; through: string }): Record<PriorEarningBucket, string> {
  const totals = { regular: '0', overtime: '0', vacationPay: '0', holidayPay: '0' };
  for (const period of periods) for (const line of period.lines) {
    if (line.earnedThrough < window.from || line.earnedFrom > window.through) continue;
    if (line.earnedFrom < window.from || line.earnedThrough > window.through) throw new PayrollError(`Prior earning ${line.sourceKey} crosses the statutory lookback boundary — record source-supported earning splits before calculating`);
    totals[line.bucket] = add(totals[line.bucket], line.amount);
  }
  return totals;
}
