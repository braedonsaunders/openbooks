import assert from 'node:assert/strict'
import test from 'node:test'
import {
  payrollCertificate,
  resolveCertificate,
  type ResolvedCertificate,
} from '../certificates.ts'
import { PAYROLL_COUNTRY_PACKS } from '../packs.ts'
import { computeUsWithholding, US_SEPARATE_SUPPLEMENTAL_METHODS } from './withholding.ts'
import { US_STATES } from './rates.ts'
import { reduceTaxBases } from '../treatment-bases.ts'
import { AL_WITHHOLDING } from './states/al.ts'
import { OR_WITHHOLDING } from './states/or.ts'
import {
  requireUsWageAllocation,
  resolveUsResidentWithholdingFacts,
} from './states/types.ts'
import { adjustResidentWithholding, residentWaivedWages, type ResolvedWithholdingLevy } from '../withholding-resolution.ts'

const PAY_DATE = '2026-07-21'
const PERIOD_END = '2026-07-18'
const CURRENT_FIT = '35.1900'
const STALE_FIT = '1000.0000'

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
    certificateFor: (key) => key === certificateKey ? stale : null,
    tenantRates: () => undefined,
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

  const neBases = reduceTaxBases([{ kind: 'deduction', amount: '300.0000', taxTreatment: 'pension_f' }, { kind: 'deduction', amount: '200.0000', taxTreatment: 'union_dues' }], { income: '805.0000', nonPeriodic: '0.0000', pensionable: '805.0000', insurable: '805.0000', 'state:US:NE:income': '805.0000', 'state:US:NE:nonPeriodic': '0.0000' }, PAYROLL_COUNTRY_PACKS.US!.deductionTreatments)
  // Circular EN §8: 1.5% of $505 state wages; dues are post-tax.
  assert.equal(computeUsWithholding({ ...adapterInput('NE', 'us_ne_w4n', certificate('us_ne_w4n', { filing_status: 'single', allowances: '100' })), periodsPerYear: 52, wages: '805.0000', taxableWageBases: neBases, employerEmployeeCount: 25 })?.tax, '7.5800')
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

test('Detroit resident withholding offsets the other city rate and refuses an unknown rate', () => {
  // Michigan Treasury Form 5469, 2026 guide: https://www.michigan.gov/taxes/-/media/Project/Websites/taxes/Forms/City-Withholding/TY2026/5469_ty2026.pdf
  const input = {
    ...dispatchInput('MI', 'DETROIT', 'us_mi_5527', () => certificate('us_mi_5527', {}), () => undefined),
    wageAllocations: [
      { region: 'MI', subRegion: 'GRAND_RAPIDS', workShare: '0.6', source: 'time', sourceWagesCurrentPeriod: '1200.00' },
      { region: 'MI', subRegion: 'HIGHLAND_PARK', workShare: '0.4', source: 'time', sourceWagesCurrentPeriod: '800.00' },
    ],
  }
  // Two other cities price each city's credit separately: $1,200 at 2.4% − 0.75% plus $800 at 2.4% − 0.50% = 19.80 + 15.20.
  assert.equal(computeUsWithholding({ ...input, detroitOtherCities: [{ code: 'GRAND_RAPIDS', nonresidentRate: '0.0075' }, { code: 'HIGHLAND_PARK', nonresidentRate: '0.005' }] })?.tax, '35.0000')
  assert.throws(() => computeUsWithholding({ ...input, detroitOtherCities: [{ code: 'GRAND_RAPIDS', nonresidentRate: null }] }), /GRAND_RAPIDS nonresident rate.*us_mi_city settings/)
})

test('Ohio school-district dispatch applies the IT 4 exemption count', () => {
  // District 0303: (52,000 − 650) × 1.25% ÷ 26 = 24.69 with one exemption.
  const withExemption = certificate('us_oh_it4', { total_exemptions: '1' })
  const input = dispatchInput('OH', '0303', 'us_oh_it4', () => withExemption, () => undefined)
  const result = computeUsWithholding(input)
  assert.equal(result?.code, 'OH-0303')
  assert.equal(result?.tax, '24.6900')

  const without = computeUsWithholding({
    ...input, certificateFor: (key) => key === 'us_oh_it4' ? certificate('us_oh_it4', {}) : null,
  })
  assert.equal(without?.tax, '25.0000')
})

test('an Ohio school-district number with no tax is refused by name', () => {
  // 9999 is absent from the Department list and must not compute zero.
  assert.throws(
    () => computeUsWithholding(
      dispatchInput('OH', '9999', 'us_oh_it4', () => certificate('us_oh_it4', {}), () => undefined),
    ),
    /Ohio school district 9999 does not levy an income tax/,
  )
})

test('PA Act 32 EIT withholds at the winning reach rate and refuses a missing one', () => {
  // Resolver-selected resident and nonresident rates must remain distinct.
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

  // No rate entered: refuse naming the PSD and the DCED register.
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

test('local W-2 wages use the sourced work allocation instead of repeating state wages', () => {
  // IRS Instructions for Forms W-2 and W-3, boxes 18–20:
  // https://www.irs.gov/instructions/iw2w3
  const input = {
    ...dispatchInput('PA', '150001', 'us_pa_clgs32_6', () => null,
      () => ({ residentRate: '0.0100', nonresidentRate: '0.0050' }), 'nonresident'),
    wages: '2000.0000',
    supplemental: '300.0000',
    supplementalPaymentTiming: 'combined' as const,
    wageAllocations: [{
      region: 'PA', subRegion: '150001', workShare: '0.600000', source: 'verified work records',
    }],
  } as Parameters<typeof computeUsWithholding>[0]
  const result = computeUsWithholding(input)
  assert.equal(result?.localTaxableWages, '1380.0000')
})

test('Delaware refuses separately paid supplemental wages without Section 14 differential inputs', () => {
  // Delaware Employer's Guide §14: https://revenue.delaware.gov/employers-guide-withholding-regulations-employers-duties/
  const input = {
    levy: levy('DE', 'us_de_sdw4a'),
    payDate: '2026-07-21', periodEnd: PERIOD_END, periodsPerYear: 26,
    wages: '0.0000', supplemental: '1000.0000',
    supplementalPaymentTiming: 'separate' as const,
    certificateFor: () => null, tenantRates: () => undefined,
    federalIncomeTax: '0.0000',
  } as Parameters<typeof computeUsWithholding>[0]

  assert.throws(
    () => computeUsWithholding(input),
    /DE income tax separately paid supplemental wages require a declared state method; Delaware Employer's Guide Section 14 requires the incremental withholding differential.*refused by name/,
  )
})

test('Alabama separately paid bonus uses the 5% rate effective in 2026', () => {
  // Alabama Withholding Tax Booklet A (Jan. 2026), p. 3: https://www.revenue.alabama.gov/wp-content/uploads/2026/01/whbooklet_0126.pdf
  const result = computeUsWithholding({
    levy: levy('AL', 'us_al_a4'),
    payDate: '2026-01-01', periodEnd: PERIOD_END, periodsPerYear: 26,
    wages: '0.0000', supplemental: '1000.0000',
    supplementalPaymentTiming: 'separate',
    certificateFor: (key) => key === 'us_al_a4' ? certificate('us_al_a4', { exemption: '0', dependents: '0' }) : null,
    tenantRates: () => undefined, federalIncomeTax: '0.0000',
  } as Parameters<typeof computeUsWithholding>[0])

  assert.equal(result?.tax, '50.0000')
  assert.equal(result?.factors.US_SUPPLEMENTAL_METHOD, 'flat')
  assert.equal(result?.factors.US_SUPPLEMENTAL_RATE, '0.05')
})

test('US supplemental withholding refuses when payment timing was not captured', () => {
  const input = {
    levy: levy('DE', 'us_de_sdw4a'),
    payDate: PAY_DATE, periodEnd: PERIOD_END, periodsPerYear: 26,
    wages: '2000.0000', supplemental: '500.0000',
    certificateFor: () => null, tenantRates: () => undefined,
    federalIncomeTax: '0.0000',
  } as Parameters<typeof computeUsWithholding>[0]

  assert.throws(
    () => computeUsWithholding(input),
    /supplemental timing is missing for DE income tax.*refused by name/,
  )
})

test('Georgia separately paid bonus uses the effective flat supplemental rate', () => {
  // O.C.G.A. §48-7-101(f)(5), 2026 Employer's Tax Guide: https://dor.georgia.gov/document/document-document/2026-employers-tax-guide-updated-june-2026/download
  const input = {
    levy: levy('GA', 'us_ga_g4'),
    payDate: '2026-05-11', periodEnd: PERIOD_END, periodsPerYear: 26,
    wages: '0.0000', supplemental: '500.0000',
    supplementalPaymentTiming: 'separate' as const,
    certificateFor: (key) => key === 'us_ga_g4' ? certificate('us_ga_g4', {}) : null, tenantRates: () => undefined,
    federalIncomeTax: '0.0000',
  } as Parameters<typeof computeUsWithholding>[0]
  const result = computeUsWithholding(input)
  assert.equal(result?.tax, '24.9500')
  assert.equal(result?.factors.US_SUPPLEMENTAL_RATE, '0.0499')
  assert.equal(result?.factors.US_SUPPLEMENTAL_TAX, '24.9500')

  const beforeRateChange = computeUsWithholding({
    ...input, payDate: '2026-05-10',
  })
  assert.equal(beforeRateChange?.tax, '25.9500')
  assert.equal(beforeRateChange?.factors.US_SUPPLEMENTAL_RATE, '0.0519')
})

test('Maryland separately paid annual bonus routes to the lump-sum calculation', () => {
  // Comptroller of Maryland, 2026 Employer Withholding Guide, p. 9:
  // $1,000 × (6.50% + 3.20% Montgomery highest local) = $97.00.
  const result = computeUsWithholding({
    levy: levy('MD', 'us_md_mw507'),
    payDate: '2026-03-06', periodEnd: PERIOD_END, periodsPerYear: 52,
    wages: '0.0000', supplemental: '1000.0000',
    supplementalPaymentTiming: 'separate',
    certificateFor: () => certificate('us_md_mw507', {
      filing_status: 'single', exemptions: '1', residence_county: '16',
    }),
    tenantRates: () => undefined, federalIncomeTax: '0.0000',
  } as Parameters<typeof computeUsWithholding>[0])
  assert.equal(result?.tax, '97.0000')
  assert.equal(result?.factors.US_SUPPLEMENTAL_METHOD, 'lump_sum')
  assert.equal(result?.factors.US_SUPPLEMENTAL_TAX, '97.0000')
})

test('Michigan separately paid bonus uses 4.25% without the period exemption', () => {
  // Michigan Form 446 (2026): https://www.michigan.gov/taxes/-/media/Project/Websites/taxes/Forms/SUW/TY2026/446_Withholding-Guide_2026.pdf
  const result = computeUsWithholding({
    levy: levy('MI', 'us_mi_miw4'),
    payDate: '2026-07-21', periodEnd: PERIOD_END, periodsPerYear: 26,
    wages: '0.0000', supplemental: '500.0000',
    supplementalPaymentTiming: 'separate',
    certificateFor: (key) => key === 'us_mi_miw4' ? certificate('us_mi_miw4', { exemptions: '99' }) : null,
    tenantRates: () => undefined, federalIncomeTax: '0.0000',
  } as Parameters<typeof computeUsWithholding>[0])
  assert.equal(result?.tax, '21.2500')
  assert.equal(result?.factors.US_SUPPLEMENTAL_RATE, '0.0425')
  assert.equal(result?.factors.US_SUPPLEMENTAL_TAX, '21.2500')
})

test('Idaho separately paid bonus uses the 5.3% supplemental rate to the whole dollar', () => {
  // Idaho State Tax Commission, Computing Withholding ("Supplemental wages"):
  // https://tax.idaho.gov/taxes/income-tax/withholding/computing/
  const result = computeUsWithholding({
    levy: levy('ID', 'us_id_idw4'),
    payDate: '2026-08-15', periodEnd: PERIOD_END, periodsPerYear: 26,
    wages: '0.0000', supplemental: '1000.0000',
    supplementalPaymentTiming: 'separate',
    certificateFor: () => certificate('us_id_idw4', { filing_status: 'single', allowances: '4' }),
    tenantRates: () => undefined, federalIncomeTax: '0.0000',
  } as Parameters<typeof computeUsWithholding>[0])
  assert.equal(result?.tax, '53.0000')
  assert.equal(result?.factors.US_SUPPLEMENTAL_RATE, '0.053')
  assert.equal(result?.factors.US_SUPPLEMENTAL_TAX, '53.0000')
})

test('Minnesota separately paid supplemental wages use Method 2 at 6.25%', () => {
  // Minnesota 2026 Withholding Tax Instructions, p. 7: https://www.revenue.state.mn.us/sites/default/files/2025-12/wh-inst-26.pdf
  const result = computeUsWithholding({
    levy: levy('MN', 'us_mn_w4mn'),
    payDate: '2026-07-21', periodEnd: PERIOD_END, periodsPerYear: 26,
    wages: '0.0000', supplemental: '4000.0000',
    supplementalPaymentTiming: 'separate',
    certificateFor: (key) => key === 'us_mn_w4mn' ? certificate('us_mn_w4mn', { marital_status: 'married', allowances: '9' }) : null,
    tenantRates: () => undefined, federalIncomeTax: '0.0000',
  } as Parameters<typeof computeUsWithholding>[0])
  assert.equal(result?.tax, '250.0000')
  assert.equal(result?.factors.US_SUPPLEMENTAL_METHOD, 'flat')
  assert.equal(result?.factors.US_SUPPLEMENTAL_RATE, '0.0625')
})

test('Missouri separately paid bonus uses 4.7% while regular withholding is in effect', () => {
  // Missouri DOR Form 4282 (Rev. 03-2026), §7.A: https://dor.mo.gov/forms/4282_2026.pdf
  const result = computeUsWithholding({
    levy: levy('MO', 'us_mo_mow4'),
    payDate: '2026-03-15', periodEnd: PERIOD_END, periodsPerYear: 24,
    wages: '0.0000', supplemental: '1000.0000',
    supplementalPaymentTiming: 'separate',
    regularWageTaxWithheldThisYear: true,
    certificateFor: () => certificate('us_mo_mow4', { filing_status: 'single' }),
    tenantRates: () => undefined, federalIncomeTax: '0.0000',
  } as Parameters<typeof computeUsWithholding>[0])
  assert.equal(result?.tax, '47.0000')
  assert.equal(result?.factors.US_SUPPLEMENTAL_RATE, '0.047')
  assert.equal(result?.factors.US_SUPPLEMENTAL_TAX, '47.0000')
})

test('Montana separately paid supplemental wages use the guide’s 5% option', () => {
  // Montana Employer and Information Agent Guide with Tax Tables – 2026, p. 3
  // allows a separately paid supplemental to be withheld at 5% of that wage.
  const result = computeUsWithholding({
    levy: levy('MT', 'us_mt_mw4'),
    payDate: '2026-06-01', periodEnd: PERIOD_END, periodsPerYear: 26,
    wages: '0.0000', supplemental: '500.0000', supplementalPaymentTiming: 'separate',
    federalIncomeTax: '0.00', certificateFor: (key) => key === 'us_mt_mw4' ? certificate('us_mt_mw4', {}) : null,
    tenantRates: () => undefined,
  })
  assert.equal(result?.tax, '25.0000')
  assert.equal(result?.factors.US_SUPPLEMENTAL_METHOD, 'flat')
  assert.equal(result?.factors.US_SUPPLEMENTAL_RATE, '0.05')
})

test('North Carolina separate supplementals use 4.09% only with regular withholding history', () => {
  // NC-30 (2026), §12: the 4.09% flat option is conditional on tax having
  // been withheld from regular wages; the guide requires its aggregate method otherwise.
  const input = {
    levy: levy('NC', 'us_nc_nc4'), payDate: '2026-06-01', periodEnd: PERIOD_END,
    periodsPerYear: 26, wages: '0.0000', supplemental: '500.0000',
    supplementalPaymentTiming: 'separate' as const, federalIncomeTax: '0.00',
    certificateFor: (key: string) => key === 'us_nc_nc4' ? certificate('us_nc_nc4', {}) : null, tenantRates: () => undefined,
  }
  const result = computeUsWithholding({ ...input, regularWageTaxWithheldThisYear: true })
  assert.equal(result?.tax, '20.0000')
  assert.equal(result?.factors.US_SUPPLEMENTAL_RATE, '0.0409')
  assert.throws(
    () => computeUsWithholding(input),
    /NC income tax cannot use its separate-supplemental flat rate without committed evidence of regular-wage withholding.*refused by name/,
  )
})

test('North Dakota and Nebraska separate supplementals use their published flat rates', () => {
  // ND 2026 Rates and Instructions, Supplemental Wages, Option 1: 1.50%.
  const nd = computeUsWithholding({
    levy: levy('ND', 'us_nd_w4'), payDate: '2026-06-01', periodEnd: PERIOD_END,
    periodsPerYear: 26, wages: '0.0000', supplemental: '500.0000', taxableWageBases: { income: '0.0000', nonPeriodic: '500.0000', pensionable: '0.0000', insurable: '0.0000', 'state:US:ND:income': '0.0000', 'state:US:ND:nonPeriodic': '500.0000' },
    supplementalPaymentTiming: 'separate', federalIncomeTax: '0.00',
    certificateFor: (key) => key === 'us_nd_w4' ? certificate('us_nd_w4', {}) : null, tenantRates: () => undefined,
  })
  assert.equal(nd?.tax, '7.5000')
  assert.equal(nd?.factors.US_SUPPLEMENTAL_RATE, '0.015')

  // Nebraska Circular EN 2026, Bonuses and Supplemental Wages: elected 3.5%.
  const ne = computeUsWithholding({
    levy: levy('NE', 'us_ne_w4n'), payDate: '2026-06-01', periodEnd: PERIOD_END,
    periodsPerYear: 26, employerEmployeeCount: 2, wages: '0.0000', supplemental: '500.0000', taxableWageBases: { income: '0.0000', nonPeriodic: '500.0000', pensionable: '0.0000', insurable: '0.0000', 'state:US:NE:income': '0.0000', 'state:US:NE:nonPeriodic': '500.0000' },
    supplementalPaymentTiming: 'separate', federalIncomeTax: '0.00',
    certificateFor: (key) => key === 'us_ne_w4n' ? certificate('us_ne_w4n', {}) : null, tenantRates: () => undefined,
  })
  assert.equal(ne?.tax, '17.5000')
  assert.equal(ne?.factors.US_SUPPLEMENTAL_RATE, '0.035')
})

test('Arkansas combined bonus uses the bonus rate beside the regular formula', () => {
  // Arkansas DFA 2026 Employer Instructions, p. 4, require formula withholding
  // on regular wages and 3.9% of bonuses paid at the same time:
  // https://www.dfa.arkansas.gov/wp-content/uploads/withholdInstructions_2026.pdf
  // At $900 biweekly, the $23,400 annualized regular wage is in the 3.4% band:
  // $424 rounded annual tax / 26 = $16.31 rounded to cents. The separate
  // $1,000 bonus is $39.
  const result = computeUsWithholding({
    levy: levy('AR', 'us_ar_ar4ec'), payDate: '2026-06-01', periodEnd: PERIOD_END,
    periodsPerYear: 26, wages: '900.0000', supplemental: '1000.0000',
    supplementalPaymentTiming: 'combined', federalIncomeTax: '0.00',
    certificateFor: (key) => key === 'us_ar_ar4ec' ? certificate('us_ar_ar4ec', {}) : null, tenantRates: () => undefined,
  })
  assert.equal(result?.tax, '55.3100')
  assert.equal(result?.factors.US_SUPPLEMENTAL_RATE, '0.039')
  assert.equal(result?.factors.US_SUPPLEMENTAL_TAX, '39.0000')
})

test('Virginia separate supplemental flat election requires regular withholding history', () => {
  // Virginia Employer Withholding Instructions, p. 19, allows the 5.75% flat
  // separate-payment method when regular wages had tax withheld.
  const input = {
    levy: levy('VA', 'us_va_va4'), payDate: '2026-06-01', periodEnd: PERIOD_END,
    periodsPerYear: 26, wages: '0.0000', supplemental: '500.0000',
    supplementalPaymentTiming: 'separate' as const, federalIncomeTax: '0.00',
    certificateFor: (key: string) => key === 'us_va_va4' ? certificate('us_va_va4', {}) : null, tenantRates: () => undefined,
  }
  const result = computeUsWithholding({ ...input, regularWageTaxWithheldThisYear: true })
  assert.equal(result?.tax, '28.7500')
  assert.equal(result?.factors.US_SUPPLEMENTAL_RATE, '0.0575')
  assert.throws(
    () => computeUsWithholding(input),
    /VA income tax cannot use its separate-supplemental flat rate without committed evidence of regular-wage withholding.*refused by name/,
  )
})

test('New York separate supplemental rates follow the NYS and NYC schedules', () => {
  // NYS-50-T-NYS and NYS-50-T-NYC (1/26), p. 3, publish 11.70% and 4.25%
  // respectively. Both flat options require withholding from their own
  // regular-wage levy; a state withholding fact cannot unlock the city rate.
  const nys = computeUsWithholding({
    levy: levy('NY', 'us_ny_it2104'), payDate: '2026-06-01', periodEnd: PERIOD_END,
    periodsPerYear: 26, wages: '0.0000', supplemental: '500.0000',
    supplementalPaymentTiming: 'separate', regularWageTaxWithheldThisYear: true,
    federalIncomeTax: '0.00', certificateFor: (key) => key === 'us_ny_it2104' ? certificate('us_ny_it2104', {}) : null,
    tenantRates: () => undefined,
  })
  assert.equal(nys?.tax, '58.5000')
  assert.equal(nys?.factors.US_SUPPLEMENTAL_RATE, '0.1170')

  const nycLevy: ResolvedWithholdingLevy = {
    ...levy('NY', 'us_ny_it2104'), level: 'sub_region', subRegion: 'NYC',
    label: 'New York City income tax',
  }
  const nycInput = {
    levy: nycLevy, payDate: '2026-06-01', periodEnd: PERIOD_END, periodsPerYear: 26,
    wages: '0.0000', supplemental: '500.0000', supplementalPaymentTiming: 'separate' as const,
    federalIncomeTax: '0.00', certificateFor: (key: string) => key === 'us_ny_it2104' ? certificate('us_ny_it2104', {}) : null,
    tenantRates: () => undefined,
  }
  assert.throws(
    () => computeUsWithholding({ ...nycInput, regularWageTaxWithheldThisYear: true }),
    /New York City income tax cannot use its separate-supplemental flat rate without committed evidence of regular-wage withholding.*refused by name/,
  )
  const nyc = computeUsWithholding({
    ...nycInput, regularWageTaxWithheldFor: ['LIT_NY-NYC'],
  })
  assert.equal(nyc?.tax, '21.2500')
  assert.equal(nyc?.factors.US_SUPPLEMENTAL_RATE, '0.0425')
})

test('US regional and subregional methods receive exact, sourced allocation facts', () => {
  const allocation = {
    region: 'MI', subRegion: 'DETROIT', workShare: '0.250000', source: 'approved work-location record',
  }
  assert.deepEqual(
    requireUsWageAllocation([allocation], 'MI', 'DETROIT'),
    allocation,
  )
  assert.throws(
    () => requireUsWageAllocation([], 'MI', 'DETROIT'),
    /MI\/DETROIT needs exactly one current-period work allocation; found 0.*refused by name/,
  )
  assert.throws(
    () => requireUsWageAllocation([allocation, allocation], 'MI', 'DETROIT'),
    /MI\/DETROIT needs exactly one current-period work allocation; found 2.*refused by name/,
  )
  assert.throws(
    () => requireUsWageAllocation([{ ...allocation, workShare: '1.000001' }], 'MI', 'DETROIT'),
    /work allocation is outside 0–1.*refused by name/,
  )
})

test('US resident credits price only sourced out-of-region wages and require each work-region tax', () => {
  const allocations = [
    { region: 'NY', subRegion: null, workShare: '0.25', source: 'verified time records' },
    { region: 'NJ', subRegion: null, workShare: '0.75', source: 'verified time records' },
    { region: 'NJ', subRegion: 'NEWARK', workShare: '0.5', source: 'local worksite certificate' },
  ]
  assert.deepEqual(
    resolveUsResidentWithholdingFacts(
      '2000.0000', allocations, [{ region: 'NJ', amount: '42.00' }], 'NY',
    ),
    { outOfRegionWages: '1500.0000', workRegionTaxes: [{ region: 'NJ', amount: '42.00' }], workRegionWages: [{ region: 'NJ', amount: '1500.0000' }] },
  )
  assert.equal(residentWaivedWages([{ region: 'NJ', amount: '42.00' }], [{ region: 'NJ', amount: '1500.00' }], { kind: 'waive_when_work_region_withheld' }), '1500.0000')
  assert.deepEqual(adjustResidentWithholding('100.00', '7.50', [{ region: 'NJ', amount: '120.00' }], { kind: 'net_of_work_region_tax' }), { statutoryTax: '0.0000', additionalWithholding: '7.5000', tax: '7.5000', outcome: 'withheld', workRegionTaxCredit: '100.0000' })
  assert.throws(
    () => resolveUsResidentWithholdingFacts('2000.0000', allocations, [], 'NY'),
    /same-period computed work-region tax for NJ.*refused by name/,
  )
  assert.throws(
    () => resolveUsResidentWithholdingFacts(
      '2000.0000', [allocations[0]!], [{ region: 'NJ', amount: '42.00' }], 'NY',
    ),
    /region shares must total exactly 1.*refused by name/,
  )
})

test('US resident withholding requires its out-of-region wages and actual work-state tax', () => {
  const residentLevy = {
    ...levy('NY', 'us_ny_it2104'),
    basis: 'resident_out_of_region' as const,
    creditAgainstRegion: 'NJ',
    residentWithholdingMethod: { kind: 'net_of_work_region_tax' as const },
  }
  assert.throws(
    () => computeUsWithholding({
      levy: residentLevy,
      payDate: PAY_DATE, periodEnd: PERIOD_END, periodsPerYear: 26,
      wages: '1000.00', supplemental: '0.00', federalIncomeTax: '0.00',
      certificateFor: () => null, tenantRates: () => undefined,
    }),
    /NY resident withholding needs verified out-of-region wages and same-period work-region taxes.*refused by name/,
  )
  const fullHi = computeUsWithholding({ levy: { ...levy('HI', 'us_hi_hw4'), basis: 'resident_out_of_region', residentWithholdingMethod: { kind: 'full' } }, payDate: PAY_DATE, periodEnd: PERIOD_END, periodsPerYear: 26, wages: '1000.00', supplemental: '0.00', federalIncomeTax: '0.00', certificateFor: key => certificate(key, {}), tenantRates: () => undefined })!
  assert.ok(fullHi.tax)
  const scLevy = { ...levy('SC', 'us_sc_scw4'), basis: 'resident_out_of_region' as const, residentWithholdingMethod: { kind: 'waive_when_work_region_withheld' as const, regions: ['NJ'] } }
  const scFacts = { outOfRegionWages: '600.00', workRegionTaxes: [{ region: 'NJ', amount: '25.00' }], workRegionWages: [{ region: 'NJ', amount: '600.00' }] }
  const scCertificate = (key: string) => certificate(key, { allowances: '0', additional_per_period: '5.00' })
  const residentSc = computeUsWithholding({ levy: scLevy, payDate: PAY_DATE, periodEnd: PERIOD_END, periodsPerYear: 26, wages: '1000.00', supplemental: '0.00', federalIncomeTax: '0.00', residentWithholdingFacts: scFacts, certificateFor: scCertificate, tenantRates: () => undefined })!
  const eligibleSc = computeUsWithholding({ levy: levy('SC', 'us_sc_scw4'), payDate: PAY_DATE, periodEnd: PERIOD_END, periodsPerYear: 26, wages: '400.00', supplemental: '0.00', federalIncomeTax: '0.00', certificateFor: scCertificate, tenantRates: () => undefined })!
  assert.equal(residentSc.tax, eligibleSc.tax)
  assert.equal(residentSc.additionalWithholding, '5.0000')
  assert.equal(residentSc.factors.US_RESIDENT_WITHHOLDING_OUTCOME, 'eligible_to_waive_covered_wages')
})

test('US states declare methods and California applies the classified bonus rate', () => {
  assert.deepEqual(
    Object.keys(US_SEPARATE_SUPPLEMENTAL_METHODS).sort(),
    [...US_STATES].sort(),
  )
  // EDD DE 44 Rev. 52 (4-26), p. 18: https://edd.ca.gov/pdf_pub_ctr/de44.pdf
  assert.equal(computeUsWithholding({ levy: levy('CA', 'us_ca_de4'), payDate: PAY_DATE,
    periodEnd: PERIOD_END, periodsPerYear: 26, wages: '0', supplemental: '1000',
    supplementalPaymentTiming: 'separate', supplementalWageAmounts: [{ category: 'bonus_or_stock_option', amount: '1000' }],
    certificateFor: (key) => key === 'us_ca_de4' ? certificate('us_ca_de4', { filing_status: 'single_or_dual', regular_allowances: '0', estimated_deduction_allowances: '0' }) : null,
    tenantRates: () => undefined, federalIncomeTax: '0',
  } as Parameters<typeof computeUsWithholding>[0])?.tax, '102.3000')
})
