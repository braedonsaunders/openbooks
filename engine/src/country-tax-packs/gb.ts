import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const GB_VAT100: TaxReturnPack = {
  code: "GB_VAT100",
  name: "VAT Return (VAT100)",
  country: "GB",
  jurisdiction: { code: "GB", name: "United Kingdom", country: "GB", level: "country", taxType: "vat" },
  defaultFrequency: "quarterly",
  submissionChannel: "efile_api",
  governmentFormat: "api",
  submissionUrl: "https://www.gov.uk/submit-vat-return",
  watermark: "Working copy — submit through compatible Making Tax Digital software",
  boxes: [
    { lineCode: "1", label: "VAT due in the period on sales and other outputs", sign: -1, sequence: 10, basis: "tax_collected", glMap: "sales" },
    { lineCode: "2", label: "VAT due in the period on acquisitions of goods made in Northern Ireland from EU member states", sign: 1, sequence: 20 },
    { lineCode: "3", label: "Total VAT due", sign: 1, sequence: 30, formula: "1 + 2" },
    { lineCode: "4", label: "VAT reclaimed in the period on purchases and other inputs, including acquisitions", sign: 1, sequence: 40, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "5", label: "Net VAT to pay to HMRC or reclaim", sign: 1, sequence: 50, formula: "abs(3 - 4)" },
    { lineCode: "6", label: "Total value of sales and all other outputs excluding VAT", sign: 1, sequence: 60, basis: "taxable_base", glMap: "sales" },
    { lineCode: "7", label: "Total value of purchases and all other inputs excluding VAT", sign: 1, sequence: 70, basis: "taxable_base", glMap: "purchases" },
    { lineCode: "8", label: "Total value of dispatches of goods and related costs, excluding VAT, from Northern Ireland to EU member states", sign: 1, sequence: 80 },
    { lineCode: "9", label: "Total value of acquisitions of goods and related costs, excluding VAT, made in Northern Ireland from EU member states", sign: 1, sequence: 90 },
  ],
};

/** United Kingdom VAT localization maintained from HMRC sources. */
export const UNITED_KINGDOM_TAX_PACK: CountryTaxPackDefinition = {
  code: "GB_INDIRECT_TAX",
  version: "2026.08.01",
  country: "GB",
  name: "United Kingdom",
  countryTaxType: "vat",
  parentReturnPackCode: "GB_VAT100",
  completeness: {
    jurisdictions: "not_applicable",
    standardRates: "complete",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "hmrc_vat_rate_history",
      title: "HMRC VAT Notice 700 — historic and current VAT rates",
      url: "https://www.gov.uk/guidance/vat-guide-notice-700",
      asOf: "2026-08-01",
    },
    {
      id: "hmrc_vat_return_boxes",
      title: "HMRC VAT Notice 700/12 — how to fill in and submit a VAT Return",
      url: "https://www.gov.uk/guidance/how-to-fill-in-and-submit-your-vat-return-vat-notice-70012",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [GB_VAT100],
  returnPackTaxCodes: {
    GB_VAT100: {
      code: "GB-VAT-STD",
      name: "United Kingdom standard VAT",
      ratePercent: 20,
      rates: [
        { ratePercent: 10, effectiveFrom: "1973-04-01", effectiveTo: "1974-07-28", sourceId: "hmrc_vat_rate_history" },
        { ratePercent: 8, effectiveFrom: "1974-07-29", effectiveTo: "1979-06-17", sourceId: "hmrc_vat_rate_history" },
        { ratePercent: 15, effectiveFrom: "1979-06-18", effectiveTo: "1991-03-31", sourceId: "hmrc_vat_rate_history" },
        { ratePercent: 17.5, effectiveFrom: "1991-04-01", effectiveTo: "2008-11-30", sourceId: "hmrc_vat_rate_history" },
        { ratePercent: 15, effectiveFrom: "2008-12-01", effectiveTo: "2009-12-31", sourceId: "hmrc_vat_rate_history" },
        { ratePercent: 17.5, effectiveFrom: "2010-01-01", effectiveTo: "2011-01-03", sourceId: "hmrc_vat_rate_history" },
        { ratePercent: 20, effectiveFrom: "2011-01-04", sourceId: "hmrc_vat_rate_history" },
      ],
    },
  },
};
