import { taxYearFor } from './tax-year-math.ts';
import { PAYROLL_COUNTRY_PACKS } from './pack-registry.ts';
import { payrollFilingDeliveryScope, payrollPackFilings } from './filing-registry.ts';
import { isPayrollPackPayable, packPayableProblem } from './employee-facts.ts';
import { payrollSupportedTaxYears, payrollDraftTaxYears } from './tax-years.ts';

/** Capability inventory, derived from the same declarations used by calculation
 * and filing. Registration is implementation evidence, never agency certification. */
export function payrollSupportScope(asOf?: string) {
  return Object.values(PAYROLL_COUNTRY_PACKS).sort((a, b) => a.country.localeCompare(b.country)).map(pack => ({
    country: pack.country,
    currency: pack.statutoryCurrency,
    installable: pack.installable,
    payable: isPayrollPackPayable(pack),
    payabilityRefusal: packPayableProblem(pack),
    taxYearBasis: pack.taxYear,
    selectedTaxYear: asOf === undefined ? null : taxYearFor(pack.taxYear, asOf),
    publishedTableYears: payrollSupportedTaxYears(pack.taxYears),
    draftTableYears: payrollDraftTaxYears(pack.taxYears),
    editions: pack.taxYears.editions,
    regions: pack.regions.known.map(region => ({
      region, name: pack.regions.regionNames[region],
      incomeTaxImplemented: pack.regions.supported.includes(region),
      refusal: pack.regions.supported.includes(region) ? null
        : (pack.regions.unsupportedReasons?.[region] ?? pack.regions.unsupportedReason).replaceAll('{region}', region),
      publishedTableYears: payrollSupportedTaxYears(pack.taxYears, region),
    })),
    obligations: pack.statutorySlots.flatMap(slot => slot.components).map(component => ({
      key: component.systemKey, assessedOn: component.assessedOn, remittance: component.remittance,
    })),
    remittanceSchedules: (pack.remittanceSchedules ?? []).map(schedule => ({
      authority: schedule.authority, effectiveFrom: schedule.effectiveFrom,
      effectiveTo: schedule.effectiveTo ?? null, sources: schedule.sources,
      frequencies: schedule.frequencies,
    })),
    filings: payrollPackFilings(pack.country).yearEnd.map(filing => ({
      key: filing.key, label: filing.label, cadence: filing.cadence,
      yearCoverage: { status: 'validate-requested-year',
        reason: 'Calculation table editions do not establish filing-format coverage; validate the exact requested year with the filing builder and agency' },
      originalSlip: Boolean(filing.slip), originalFile: Boolean(filing.download), originalFileRefusal: filing.downloadRefusal ?? null,
      correction: filing.amendment.supported,
      correctionFile: filing.amendment.supported && Boolean(filing.amendment.download),
      correctionRefusal: filing.amendment.supported ? (filing.amendment.downloadRefusal ?? null) : filing.amendment.refusal,
      ...payrollFilingDeliveryScope(filing),
    })),
    assurance: 'Declared implementation; agency acceptance and employer-specific applicability require validation',
  }));
}

export type PayrollSupportScope = ReturnType<typeof payrollSupportScope>;
