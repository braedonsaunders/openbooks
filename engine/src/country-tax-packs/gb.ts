import { constructionReverseChargeRulesForCountry } from "./contractor-reverse-charge.ts";
import type { ContractorWithholdingSchemeDefinition, CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

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

/**
 * Construction Industry Scheme: a contractor deducts tax from the labour part
 * of each payment to a subcontractor, at the band HMRC returns when the
 * subcontractor is verified, and reports monthly on the CIS300 return.
 */
const GB_CIS: ContractorWithholdingSchemeDefinition = {
  code: "GB_CIS",
  country: "GB",
  name: "Construction Industry Scheme",
  authority: "HM Revenue & Customs",
  legalReference: "Finance Act 2004, Part 3, Chapter 3 (ss. 57-77)",
  currency: "GBP",
  // FA 2004 s.61: deduct from so much of the payment as does not represent
  // the direct cost of materials; VAT charged by the subcontractor is outside
  // the payment the deduction is computed on (CIS340).
  base: { excludesMaterials: true, excludesVat: true },
  bands: [
    {
      code: "GROSS",
      name: "Gross payment status",
      requiresVerification: true,
      rates: [{ ratePercent: "0", effectiveFrom: "2007-04-06", sourceId: "hmrc_cis340" }],
    },
    {
      code: "NET",
      name: "Registered for payment under deduction",
      requiresVerification: true,
      rates: [{ ratePercent: "20", effectiveFrom: "2007-04-06", sourceId: "hmrc_cis340" }],
    },
    {
      code: "HIGHER",
      name: "Unregistered or unmatched subcontractor",
      requiresVerification: false,
      rates: [{ ratePercent: "30", effectiveFrom: "2007-04-06", sourceId: "hmrc_cis340" }],
    },
  ],
  defaultBandCode: "HIGHER",
  // Tax months run from the 6th to the 5th. The CIS300 return is due on the
  // 19th and an electronic payment on the 22nd after the tax month ends.
  periodStartDay: 6,
  returnDue: { dayOfMonth: 19, monthsAfterPeriodEnd: 0 },
  paymentDue: { dayOfMonth: 22, monthsAfterPeriodEnd: 0 },
  paymentAuthorisation: "none",
  contractorReferenceLabel: "Accounts Office reference",
  payeeReferenceLabel: "Unique Taxpayer Reference",
  verificationLabel: "Verification number",
  sources: [
    {
      id: "hmrc_cis340",
      title: "HMRC CIS340 — Construction Industry Scheme: a guide for contractors and subcontractors",
      url: "https://www.gov.uk/government/publications/construction-industry-scheme-cis-340",
      asOf: "2026-10-08",
    },
    {
      id: "fa2004_s61",
      title: "Finance Act 2004, section 61 — deductions on account of tax from contract payments",
      url: "https://www.legislation.gov.uk/ukpga/2004/12/section/61",
      asOf: "2026-10-08",
    },
  ],
};

/** United Kingdom VAT localization maintained from HMRC sources. */
export const UNITED_KINGDOM_TAX_PACK: CountryTaxPackDefinition = {
  code: "GB_INDIRECT_TAX",
  version: "2026.08.01",
  country: "GB",
  reverseChargeRules: constructionReverseChargeRulesForCountry("GB"),
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
    GB_VAT100: [
      {
        code: "GB-VAT-STD",
        name: "United Kingdom standard VAT",
        role: "standard",
        ratePercent: "20",
        rates: [
          { ratePercent: "10", effectiveFrom: "1973-04-01", effectiveTo: "1974-07-28", sourceId: "hmrc_vat_rate_history" },
          { ratePercent: "8", effectiveFrom: "1974-07-29", effectiveTo: "1979-06-17", sourceId: "hmrc_vat_rate_history" },
          { ratePercent: "15", effectiveFrom: "1979-06-18", effectiveTo: "1991-03-31", sourceId: "hmrc_vat_rate_history" },
          { ratePercent: "17.5", effectiveFrom: "1991-04-01", effectiveTo: "2008-11-30", sourceId: "hmrc_vat_rate_history" },
          { ratePercent: "15", effectiveFrom: "2008-12-01", effectiveTo: "2009-12-31", sourceId: "hmrc_vat_rate_history" },
          { ratePercent: "17.5", effectiveFrom: "2010-01-01", effectiveTo: "2011-01-03", sourceId: "hmrc_vat_rate_history" },
          { ratePercent: "20", effectiveFrom: "2011-01-04", sourceId: "hmrc_vat_rate_history" },
        ],
      },
      {
        code: "GB-VAT-RED",
        name: "United Kingdom reduced VAT",
        role: "reduced",
        ratePercent: "5",
        rates: [
          { ratePercent: "8", effectiveFrom: "1994-04-01", effectiveTo: "1997-08-31", sourceId: "hmrc_vat_rate_history" },
          { ratePercent: "5", effectiveFrom: "1997-09-01", sourceId: "hmrc_vat_rate_history" },
        ],
      },
      {
        code: "GB-VAT-ZERO",
        name: "United Kingdom zero-rate VAT",
        role: "zero",
        ratePercent: "0",
        rates: [
          { ratePercent: "0", effectiveFrom: "1973-04-01", sourceId: "hmrc_vat_rate_history" },
        ],
      },
    ],
  },
  contractorWithholdingSchemes: [GB_CIS],
};
