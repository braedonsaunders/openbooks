import type { EnrollmentContributionSummary } from '@openbooks/engine/hrm/benefits'

/** Show each elected unit separately; hourly, annual and percentage rates cannot be added. */
export function benefitContributionLabels(
  contributions: readonly EnrollmentContributionSummary[],
  currency: string,
  t: (key: string) => string,
  side?: 'employee' | 'employer',
): string {
  return contributions
    .filter((item) => !side || (side === 'employee' ? item.kind === 'employee_deduction' : item.kind !== 'employee_deduction'))
    .map((item) => {
      const method = t(`setup.benefitContributions.options.election.${item.electionMode}`)
      const unit = t(`setup.benefitContributions.options.basis.${item.basis}`)
      const rate = item.electionMode === 'fixed'
        ? `${item.electedRate} ${item.basis === 'percent_of_eligible_pay' ? '%' : currency}`
        : item.rateFormula === 'elected_rate'
          ? `${item.policyRate} ${item.basis === 'percent_of_eligible_pay' ? '%' : currency}`
          : t(`setup.benefitContributions.options.formula.${item.rateFormula}`)
      return `${item.name}: ${rate} · ${unit} · ${method}`
    }).join('; ')
}
