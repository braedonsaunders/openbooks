import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const JP_CONSUMPTION_2025: TaxReturnPack = {
  code: "JP_CONSUMPTION",
  name: "Consumption and Local Consumption Taxes — General Form workpaper",
  country: "JP",
  jurisdiction: { code: "JP", name: "Japan", country: "JP", level: "country", taxType: "consumption" },
  defaultFrequency: "annual",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.nta.go.jp/english/taxes/consumption_tax/general_form_2025.htm",
  watermark: "Working copy — confirm the current filer/entity-specific form, separate standard and reduced rates, and review invoice-method credits, interim payments, local-tax transfers, and special methods before e-Tax filing",
  boxes: [
    { lineCode: "1", label: "Tax base", sign: 1, sequence: 10 },
    { lineCode: "2", label: "Consumption tax", sign: -1, sequence: 20 },
    { lineCode: "3", label: "Tax adjustment for excess deduction", sign: -1, sequence: 30 },
    { lineCode: "4", label: "Deductible tax on purchases", sign: 1, sequence: 40 },
    { lineCode: "5", label: "Tax relating to refunds and other charges", sign: 1, sequence: 50 },
    { lineCode: "6", label: "Tax relating to bad debt", sign: 1, sequence: 60 },
    { lineCode: "7", label: "Subtotal of deduction tax", sign: 1, sequence: 70 },
    { lineCode: "8", label: "Tax refundable for insufficient deduction", sign: 1, sequence: 80 },
    { lineCode: "9", label: "Balance", sign: 1, sequence: 90 },
    { lineCode: "10", label: "Interim payment", sign: 1, sequence: 100 },
    { lineCode: "11", label: "Amount of tax payable", sign: 1, sequence: 110 },
    { lineCode: "12", label: "Refundable interim payment", sign: 1, sequence: 120 },
    { lineCode: "26", label: "Total consumption and local consumption taxes — payable or refundable", sign: 1, sequence: 130 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — combined consumption and local consumption tax collected, all rates", sign: -1, sequence: 140, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — combined consumption and local consumption tax paid, all rates", sign: 1, sequence: 150, basis: "tax_paid", glMap: "purchases" },
  ],
};

/** Japan consumption-tax localization maintained from NTA primary sources. */
export const JAPAN_TAX_PACK: CountryTaxPackDefinition = {
  code: "JP_INDIRECT_TAX",
  version: "2026.08.01",
  country: "JP",
  name: "Japan",
  countryTaxType: "consumption",
  parentReturnPackCode: "JP_CONSUMPTION",
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
      id: "nta_consumption_tax_history",
      title: "National Tax Agency — consumption-tax history from introduction through 10%",
      url: "https://www.nta.go.jp/about/introduction/torikumi/70th_html/02_1.htm",
      asOf: "2026-08-01",
    },
    {
      id: "nta_consumption_tax_current",
      title: "National Tax Agency — current standard and reduced consumption-tax rates",
      url: "https://www.nta.go.jp/english/taxes/consumption_tax/01.htm",
      asOf: "2026-08-01",
    },
    {
      id: "nta_general_form_2025",
      title: "National Tax Agency — General Form 2025 final return guide",
      url: "https://www.nta.go.jp/english/taxes/consumption_tax/general_form_2025.htm",
      asOf: "2026-08-01",
    },
    {
      id: "nta_general_form_fields_2025",
      title: "National Tax Agency — General Form 2025, entering Page 1 and Page 2",
      url: "https://www.nta.go.jp/english/taxes/consumption_tax/pdf/2025/general_07.pdf",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [JP_CONSUMPTION_2025],
  returnPackTaxCodes: {
    JP_CONSUMPTION: {
      code: "JP-CT-STD",
      name: "Japan combined standard consumption and local consumption tax",
      ratePercent: 10,
      rates: [
        { ratePercent: 3, effectiveFrom: "1989-04-01", effectiveTo: "1997-03-31", sourceId: "nta_consumption_tax_history" },
        { ratePercent: 5, effectiveFrom: "1997-04-01", effectiveTo: "2014-03-31", sourceId: "nta_consumption_tax_history" },
        { ratePercent: 8, effectiveFrom: "2014-04-01", effectiveTo: "2019-09-30", sourceId: "nta_consumption_tax_history" },
        { ratePercent: 10, effectiveFrom: "2019-10-01", sourceId: "nta_consumption_tax_current" },
      ],
    },
  },
};
