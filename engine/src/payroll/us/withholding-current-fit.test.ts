import assert from 'node:assert/strict'
import test from 'node:test'
import {
  payrollCertificate,
  resolveCertificate,
  type ResolvedCertificate,
} from '../certificates.ts'
import { PAYROLL_COUNTRY_PACKS } from '../packs.ts'
import { computeUsWithholding } from './withholding.ts'
import { AL_WITHHOLDING } from './states/al.ts'
import { OR_WITHHOLDING } from './states/or.ts'
import type { ResolvedWithholdingLevy } from '../withholding-resolution.ts'

const PAY_DATE = '2026-07-21'
const PERIOD_END = '2026-07-18'
const CURRENT_FIT = '35.1900'
const STALE_FIT = '1000.0000'

// Materialize the built-in certificate declarations exactly as the pay-run
// pack does before resolving a stored certificate in this pure adapter test.
void PAYROLL_COUNTRY_PACKS

function certificate(
  key: string,
  answers: Record<string, string>,
): ResolvedCertificate {
  return resolveCertificate({
    certificate: payrollCertificate('US', key),
    stored: [{ certificateKey: key, answers, effectiveFrom: '2026-01-01' }],
    asOf: PAY_DATE,
  })
}

function levy(region: string, certificateKey: string): ResolvedWithholdingLevy {
  return {
    level: 'region', region, subRegion: null, label: `${region} income tax`,
    basis: 'resident', side: 'work', reach: 'resident', certificateKey,
  }
}

function adapterInput(
  region: string,
  certificateKey: string,
  stale: ResolvedCertificate,
): Parameters<typeof computeUsWithholding>[0] {
  return {
    levy: levy(region, certificateKey),
    payDate: PAY_DATE,
    periodEnd: PERIOD_END,
    periodsPerYear: 26,
    wages: '2000.0000',
    supplemental: '0.0000',
    certificateFor: () => stale,
    tenantRates: () => undefined,
    // This is the paycheck's computed FIT. Before the fix the adapter silently
    // dropped it because the state input contract had no current-FIT field.
    federalIncomeTax: CURRENT_FIT,
  } as Parameters<typeof computeUsWithholding>[0]
}

test('AL and OR state withholding use computed current-period FIT, not stale certificate answers', () => {
  const alStale = certificate('us_al_a4', {
    exemption: '0', dependents: '0', federal_income_tax_withheld: STALE_FIT,
  })
  const orStale = certificate('us_or_orw4', {
    marital_status: 'single', allowances: '0', federal_income_tax_withheld: STALE_FIT,
  })

  const al = computeUsWithholding(adapterInput('AL', 'us_al_a4', alStale))
  const or = computeUsWithholding(adapterInput('OR', 'us_or_orw4', orStale))

  const alCurrent = certificate('us_al_a4', {
    exemption: '0', dependents: '0', federal_income_tax_withheld: CURRENT_FIT,
  })
  const orCurrent = certificate('us_or_orw4', {
    marital_status: 'single', allowances: '0', federal_income_tax_withheld: CURRENT_FIT,
  })
  const common = {
    payDate: PAY_DATE, periodEnd: PERIOD_END, periodsPerYear: 26,
    wages: '2000.0000', supplemental: '0.0000', basis: 'resident' as const,
  }
  const expectedAl = AL_WITHHOLDING.compute({
    ...common, certificate: alCurrent, federalIncomeTax: CURRENT_FIT,
  } as Parameters<typeof AL_WITHHOLDING.compute>[0])
  const expectedOr = OR_WITHHOLDING.compute({
    ...common, certificate: orCurrent, federalIncomeTax: CURRENT_FIT,
  } as Parameters<typeof OR_WITHHOLDING.compute>[0])

  assert.equal(al?.tax, expectedAl.tax)
  assert.equal(or?.tax, expectedOr.tax)
  assert.notEqual(al?.tax, AL_WITHHOLDING.compute({
    ...common, certificate: alStale, federalIncomeTax: STALE_FIT,
  } as Parameters<typeof AL_WITHHOLDING.compute>[0]).tax)
  assert.notEqual(or?.tax, OR_WITHHOLDING.compute({
    ...common, certificate: orStale, federalIncomeTax: STALE_FIT,
  } as Parameters<typeof OR_WITHHOLDING.compute>[0]).tax)
})

function subRegionLevy(
  region: string,
  subRegion: string,
  certificateKey: string | null,
  reach: 'resident' | 'nonresident' = 'resident',
): ResolvedWithholdingLevy {
  return {
    level: 'sub_region', region, subRegion, label: `${region} ${subRegion}`,
    basis: 'resident', side: 'work', reach, certificateKey,
  }
}

function dispatchInput(
  region: string,
  subRegion: string,
  certificateKey: string | null,
  certificateFor: (key: string) => ResolvedCertificate | null,
  tenantRates: (rateKey: string, subRegion: string) => Record<string, string> | undefined,
  reach: 'resident' | 'nonresident' = 'resident',
): Parameters<typeof computeUsWithholding>[0] {
  return {
    levy: subRegionLevy(region, subRegion, certificateKey, reach),
    payDate: PAY_DATE,
    periodEnd: PERIOD_END,
    periodsPerYear: 26,
    wages: '2000.0000',
    certificateFor,
    tenantRates,
    federalIncomeTax: '0.0000',
  } as Parameters<typeof computeUsWithholding>[0]
}

test('Ohio school-district dispatch applies the IT 4 exemption count', () => {
  // District 0303 taxes the traditional base at 1.25%: (52,000 − 650) ×
  // 1.25% ÷ 26 = 24.69 with one exemption, 25.00 without. A dispatch that
  // reads the count as zero (negated certificate guard) silently
  // over-withholds every resident of every traditional-base district.
  const withExemption = certificate('us_oh_it4', { total_exemptions: '1' })
  const input = dispatchInput('OH', '0303', 'us_oh_it4', () => withExemption, () => undefined)
  const result = computeUsWithholding(input)
  assert.equal(result?.code, 'OH-0303')
  assert.equal(result?.tax, '24.6900')

  const without = computeUsWithholding({
    ...input, certificateFor: () => certificate('us_oh_it4', {}),
  })
  assert.equal(without?.tax, '25.0000')
})

test('an Ohio school-district number with no tax is refused by name', () => {
  // 9999 is four digits but on no Department list: the school-district path
  // must refuse naming the number, not compute a zero. (Negating the
  // district guard throws on the VALID district instead — covered above.)
  assert.throws(
    () => computeUsWithholding(
      dispatchInput('OH', '9999', 'us_oh_it4', () => certificate('us_oh_it4', {}), () => undefined),
    ),
    /Ohio school district 9999 does not levy an income tax/,
  )
})

test('PA Act 32 EIT withholds at the winning reach rate and refuses a missing one', () => {
  // The generic resolver already picked the higher rate; the dispatch applies
  // the reach it was handed. Swapping resident/nonresident withholds the
  // wrong jurisdiction's rate on every PA cheque.
  const tenantRates = () => ({ residentRate: '0.0100', nonresidentRate: '0.0050' })
  const resident = computeUsWithholding(
    dispatchInput('PA', '150001', 'us_pa_clgs32_6', () => null, tenantRates, 'resident'),
  )
  assert.equal(resident?.code, 'PA-150001')
  assert.equal(resident?.tax, '20.0000') // 2,000 × 1.00%
  const nonresident = computeUsWithholding(
    dispatchInput('PA', '150001', 'us_pa_clgs32_6', () => null, tenantRates, 'nonresident'),
  )
  assert.equal(nonresident?.tax, '10.0000') // 2,000 × 0.50%

  // No rate entered: refused naming the PSD and the DCED register — the
  // refusal sentence itself is load-bearing (a message mutant turns it to
  // NaN), and a present rate must never take this path.
  const missing = dispatchInput('PA', '150001', 'us_pa_clgs32_6', () => null, () => undefined)
  assert.throws(
    () => computeUsWithholding(missing),
    /no Act 32 local earned income tax rate has been entered for PSD 150001/,
  )
  assert.throws(
    () => computeUsWithholding(missing),
    /their own and DCED revises/,
  )
})
