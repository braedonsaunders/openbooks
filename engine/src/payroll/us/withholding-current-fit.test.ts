import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('the shared US statutory caller forwards the FIT it just calculated', () => {
  const source = readFileSync('engine/src/payroll/us/compute-statutory.ts', 'utf8')
  const call = source.match(/const withheld = computeUsWithholding\(\{[\s\S]*?\n    \}\)/)?.[0] ?? ''
  assert.match(call, /federalIncomeTax:\s*statutory\.fit\b/)
})
