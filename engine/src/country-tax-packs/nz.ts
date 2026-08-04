import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const NZ_GST101A: TaxReturnPack = {
  code: "NZ_GST101A",
  name: "Goods and services tax return (GST101A)",
  country: "NZ",
  jurisdiction: { code: "NZ", name: "New Zealand", country: "NZ", level: "country", taxType: "gst" },
  defaultFrequency: "bimonthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.ird.govt.nz/gst/filing-and-paying-gst-and-refunds/filing-gst/file-your-gst-return",
  watermark: "Working copy — file through myIR or approved accounting software",
  boxes: [
    { lineCode: "5", label: "Total sales and income for the period, including GST and zero-rated supplies", sign: 1, sequence: 10 },
    { lineCode: "6", label: "Zero-rated supplies included in box 5", sign: 1, sequence: 20 },
    { lineCode: "7", label: "Box 5 less box 6", sign: 1, sequence: 30, formula: "5 - 6" },
    { lineCode: "8", label: "GST on sales and income", sign: -1, sequence: 40, basis: "tax_collected", glMap: "sales" },
    { lineCode: "9", label: "Adjustments from the calculation sheet", sign: 1, sequence: 50 },
    { lineCode: "10", label: "Total GST collected on sales and income", sign: 1, sequence: 60, formula: "8 + 9" },
    { lineCode: "11", label: "Total purchases and expenses, including GST and excluding imported goods", sign: 1, sequence: 70 },
    { lineCode: "12", label: "GST on purchases and expenses", sign: 1, sequence: 80, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "13", label: "Credit adjustments from the calculation sheet", sign: 1, sequence: 90 },
    { lineCode: "14", label: "Total GST credit for purchases and expenses", sign: 1, sequence: 100, formula: "12 + 13" },
    { lineCode: "15", label: "GST refund or GST to pay", sign: 1, sequence: 110, formula: "abs(10 - 14)" },
  ],
};

/** New Zealand GST localization maintained from Inland Revenue and legislation. */
export const NEW_ZEALAND_TAX_PACK: CountryTaxPackDefinition = {
  code: "NZ_INDIRECT_TAX",
  version: "2026.08.01",
  country: "NZ",
  name: "New Zealand",
  countryTaxType: "gst",
  parentReturnPackCode: "NZ_GST101A",
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
      id: "nz_gst_rate_history",
      title: "Inland Revenue — GST rate history and tax fractions",
      url: "https://www.taxtechnical.ird.govt.nz/-/media/project/ir/tt/pdfs/tib/volume-37---2025/tib-vol37-no11.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "nz_gst_2010_increase",
      title: "Inland Revenue — GST rate increase from 1 October 2010",
      url: "https://www.taxtechnical.ird.govt.nz/en/new-legislation/act-articles/taxation-budget-measures-act-2010/gst-rate-increase",
      asOf: "2026-08-01",
    },
    {
      id: "nz_gst101a_guide",
      title: "Inland Revenue — Working with GST (IR375, April 2025)",
      url: "https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir300---ir399/ir375/ir375.pdf",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [NZ_GST101A],
  returnPackTaxCodes: {
    NZ_GST101A: {
      code: "NZ-GST",
      name: "New Zealand GST",
      ratePercent: 15,
      rates: [
        { ratePercent: 10, effectiveFrom: "1986-10-01", effectiveTo: "1989-06-30", sourceId: "nz_gst_rate_history" },
        { ratePercent: 12.5, effectiveFrom: "1989-07-01", effectiveTo: "2010-09-30", sourceId: "nz_gst_rate_history" },
        { ratePercent: 15, effectiveFrom: "2010-10-01", sourceId: "nz_gst_2010_increase" },
      ],
    },
  },
};
