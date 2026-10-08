import { PayrollError } from './error.ts';

export type BenefitHoursCoverage = 'earned_dates' | 'pay_period_end';
interface DatedCoverage { effectiveFrom: string; effectiveTo: string | null }

/** Configuration eligibility and counted earnings use independent date windows. */
export function benefitCoverageWindow(args: {
  rule: DatedCoverage & { ruleKey: string; basis: string; hoursCoverage?: BenefitHoursCoverage };
  enrollment: DatedCoverage; term: DatedCoverage; periodStart: string; periodEnd: string;
}): { from: string; to: string; earningsFrom: string; earningsTo: string } | null {
  const { rule, enrollment, term, periodStart, periodEnd } = args;
  const mode = rule.hoursCoverage ?? 'earned_dates';
  if (mode !== 'earned_dates' && mode !== 'pay_period_end') {
    throw new PayrollError(`Benefit rule ${rule.ruleKey} has an unsupported hours coverage policy — choose earning dates or eligibility at pay-period end in Contributions`);
  }
  if (mode === 'pay_period_end') {
    if (rule.basis !== 'per_hour') {
      throw new PayrollError(`Benefit rule ${rule.ruleKey} selects pay-period-end hours coverage without a per-hour basis — use earning-date coverage or a per-hour contribution`);
    }
    if ([rule, enrollment, term].some(window => window.effectiveFrom > periodEnd || window.effectiveTo !== null && window.effectiveTo < periodEnd)) return null;
    return { from: periodEnd, to: periodEnd, earningsFrom: periodStart, earningsTo: periodEnd };
  }
  const from = [periodStart, rule.effectiveFrom, enrollment.effectiveFrom, term.effectiveFrom].sort().at(-1)!;
  const to = [periodEnd, rule.effectiveTo, enrollment.effectiveTo, term.effectiveTo].filter((date): date is string => date !== null).sort()[0]!;
  return from > to ? null : { from, to, earningsFrom: from, earningsTo: to };
}
