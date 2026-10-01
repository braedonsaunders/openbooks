import { COUNTRY_TAX_PACKS, packTaxCodesForReturn } from './index.ts';

/** Implementation inventory from the authoritative, versioned tax-pack catalog.
 * A declared return/channel does not establish certified file or API delivery. */
export function indirectTaxSupportScope() {
  return [...COUNTRY_TAX_PACKS].sort((a, b) => a.country.localeCompare(b.country)).map(pack => ({
    country: pack.country, code: pack.code, version: pack.version, name: pack.name,
    taxType: pack.countryTaxType, completeness: pack.completeness, sources: pack.sources,
    jurisdictions: pack.jurisdictions.map(jurisdiction => ({
      region: jurisdiction.region, name: jurisdiction.name, coverage: jurisdiction.coverage,
      taxType: jurisdiction.taxType, returnPackCode: jurisdiction.returnPackCode ?? null,
      rateSchedule: jurisdiction.defaultTaxCode?.rates ?? [],
    })),
    returns: pack.returnPacks.map(form => ({
      code: form.code, name: form.name, jurisdiction: form.jurisdiction,
      frequency: form.defaultFrequency, submissionChannel: form.submissionChannel,
      governmentFormat: form.governmentFormat, submissionUrl: form.submissionUrl,
      watermark: form.watermark,
      taxCodes: packTaxCodesForReturn(pack, form.code).map(code => ({
        code: code.code, name: code.name, rateSchedule: code.rates ?? [],
        workpaperOnlyReason: code.workpaperOnlyReason ?? null,
      })),
      assurance: 'Declared return definition; validate the actual export and agency acceptance for the filing period',
    })),
  }));
}
