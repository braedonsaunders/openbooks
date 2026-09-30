import { canonicalDecimal } from '../money/exact-decimal.ts'
import { cmp, fromUnits, normalizeMoney, roundDiv, toUnits } from '../money/money.ts'
import type { ReportingFramework } from '../platform/reporting-framework.ts'

export class ProvisionError extends Error {
  readonly status = 422
  readonly name = 'ProvisionError'
}

export type ProvisionEstimate =
  | { method: 'best_estimate'; amount: string }
  | { method: 'expected_value'; outcomes: { amount: string; probability: string }[] }
  | { method: 'uniform_range'; minimum: string; maximum: string }
  | { method: 'no_better_estimate_range'; minimum: string; maximum: string }

export interface ProvisionAssessment {
  presentObligation: boolean
  outflow: 'probable' | 'possible' | 'remote'
  reliablyEstimable: boolean
  /** Professional assessment applies the organization's reporting framework;
   * the engine never invents a numeric definition of "probable". */
  evidence: string
  discounting: 'immaterial' | 'included_in_estimate' | 'undiscounted'
  discountEvidence: string
  estimate: ProvisionEstimate | null
}

export function provisionMoney(value: string, label: string): string {
  const parsed = canonicalDecimal(value)
  if (parsed === null || cmp(parsed, '0') < 0 || toUnits(parsed) > 9999999999999999999n)
    throw new ProvisionError(`${label} must be a nonnegative decimal amount within ledger precision — enter the amount as decimal text`)
  return normalizeMoney(parsed)
}

/** Measures the approved assessment, not the probability of a legal outcome.
 * Expected-value weights are summed before rounding; a range with no better
 * estimate uses the US-GAAP minimum or the IFRS equally-likely midpoint. */
export function measureProvision(framework: ReportingFramework, assessment: ProvisionAssessment) {
  if (framework !== 'ifrs' && framework !== 'us_gaap')
    throw new ProvisionError('Choose the financial reporting framework in Company Settings before assessing a provision')
  if (typeof assessment.presentObligation !== 'boolean' || typeof assessment.reliablyEstimable !== 'boolean'
      || !['probable', 'possible', 'remote'].includes(assessment.outflow))
    throw new ProvisionError('Record the present-obligation, outflow and reliable-estimation assessments explicitly')
  if (typeof assessment.evidence !== 'string' || assessment.evidence.trim().length < 20 || assessment.evidence.length > 10000)
    throw new ProvisionError('Record assessment evidence of 20–10,000 characters identifying the past event, obligation and outflow judgment')
  if (!['immaterial', 'included_in_estimate', 'undiscounted'].includes(assessment.discounting) || typeof assessment.discountEvidence !== 'string' || assessment.discountEvidence.trim().length < 20 || assessment.discountEvidence.length > 10000)
    throw new ProvisionError('Document whether time value is immaterial or included in the estimate, with the measurement evidence')
  if (framework === 'us_gaap' && assessment.discounting === 'included_in_estimate')
    throw new ProvisionError('This loss-contingency assessment records an undiscounted US GAAP estimate — use the undiscounted settlement amount; discounting exceptions require their applicable accounting model')
  if (framework === 'ifrs' && assessment.discounting === 'undiscounted')
    throw new ProvisionError('Under IFRS, assess whether time value is immaterial or include its effect in the supported settlement estimate')
  const recognized = assessment.presentObligation && assessment.outflow === 'probable' && assessment.reliablyEstimable
  let measured = '0.0000'
  const estimate = assessment.estimate
  if (recognized && !estimate)
    throw new ProvisionError('A probable, reliably estimable present obligation requires an estimate — record the supported settlement amount')
  if (estimate) {
    if (estimate.method === 'best_estimate') measured = provisionMoney(estimate.amount, 'Best estimate')
    else if (estimate.method === 'expected_value') {
      if (framework === 'us_gaap')
        throw new ProvisionError('A US GAAP loss contingency requires the supported probable loss estimate — use the best estimate or the range with no better estimate, rather than weighting possible losses')
      if (!estimate.outcomes.length || estimate.outcomes.length > 1000)
        throw new ProvisionError('Provide 1–1,000 settlement outcomes for the expected-value estimate')
      let weight = 0n, value = 0n
      for (const outcome of estimate.outcomes) {
        const amount = toUnits(provisionMoney(outcome.amount, 'Outcome amount'))
        const probability = toUnits(provisionMoney(outcome.probability, 'Outcome probability'))
        if (probability > 10000n) throw new ProvisionError('Outcome probabilities must be between zero and one')
        weight += probability; value += amount * probability
      }
      if (weight !== 10000n) throw new ProvisionError('Outcome probabilities must sum exactly to one — correct the outcome weights')
      measured = fromUnits(roundDiv(value, 10000n))
    } else if (estimate.method === 'uniform_range' || estimate.method === 'no_better_estimate_range') {
      const minimum = provisionMoney(estimate.minimum, 'Range minimum')
      const maximum = provisionMoney(estimate.maximum, 'Range maximum')
      if (cmp(minimum, maximum) > 0) throw new ProvisionError('The estimate range minimum cannot exceed its maximum')
      if (framework === 'ifrs' && estimate.method !== 'uniform_range')
        throw new ProvisionError('IFRS requires a supported best estimate; use a midpoint only when every amount in the continuous range is equally likely')
      if (framework === 'us_gaap' && estimate.method !== 'no_better_estimate_range')
        throw new ProvisionError('Under US GAAP, identify the better estimate or explicitly assess that no amount in the range is a better estimate')
      measured = framework === 'ifrs' ? fromUnits(roundDiv(toUnits(minimum) + toUnits(maximum), 2n)) : minimum
    } else throw new ProvisionError('Choose a supported provision measurement method')
  }
  if (recognized && cmp(measured, '0') <= 0)
    throw new ProvisionError('A probable outflow requires a positive supported estimate — revise the assessment or enter the obligation amount')
  return { recognized, liability: recognized ? measured : '0.0000', estimatedSettlement: measured,
    disclosureRequired: assessment.outflow !== 'remote' }
}
