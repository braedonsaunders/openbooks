import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const AE_VAT201_2026: TaxReturnPack = {
  code: "AE_VAT201",
  name: "VAT201 — VAT Return",
  country: "AE",
  jurisdiction: { code: "AE", name: "United Arab Emirates", country: "AE", level: "country", taxType: "vat" },
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://tax.gov.ae/en/taxes/Vat/vat.topics/filing.vat.returns.and.making.payments.aspx",
  watermark: "Working copy — allocate Box 1 by Emirate and review tax-period frequency, reverse charge, imports, designated zones, adjustments, and refund treatment before EmaraTax filing",
  boxes: [
    { lineCode: "1", label: "Standard-rated supplies — complete the amount and VAT amount for each Emirate", sign: 1, sequence: 10 },
    { lineCode: "2", label: "Tax refunds provided to tourists under the Tax Refunds for Tourists Scheme", sign: 1, sequence: 20 },
    { lineCode: "3", label: "Supplies subject to the reverse charge provisions", sign: 1, sequence: 30 },
    { lineCode: "4", label: "Zero-rated supplies", sign: 1, sequence: 40 },
    { lineCode: "5", label: "Exempt supplies", sign: 1, sequence: 50 },
    { lineCode: "6", label: "Goods imported into the UAE", sign: 1, sequence: 60 },
    { lineCode: "7", label: "Adjustments to goods imported into the UAE", sign: 1, sequence: 70 },
    { lineCode: "8", label: "Totals — sales and all other outputs", sign: 1, sequence: 80 },
    { lineCode: "9", label: "Standard-rated expenses", sign: 1, sequence: 90 },
    { lineCode: "10", label: "Supplies subject to reverse charge provisions — recoverable input tax", sign: 1, sequence: 100 },
    { lineCode: "11", label: "Totals — expenses and all other inputs", sign: 1, sequence: 110 },
    { lineCode: "12", label: "Total value of due tax for the period", sign: -1, sequence: 120, basis: "tax_collected", glMap: "sales" },
    { lineCode: "13", label: "Total value of recoverable tax for the period", sign: 1, sequence: 130, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "14", label: "Payable tax for the period", sign: 1, sequence: 140, formula: "12 - 13" },
  ],
};

/** United Arab Emirates VAT localization maintained from Federal Tax Authority primary sources. */
export const UNITED_ARAB_EMIRATES_TAX_PACK: CountryTaxPackDefinition = {
  code: "AE_INDIRECT_TAX",
  version: "2026.08.01",
  country: "AE",
  name: "United Arab Emirates",
  countryTaxType: "vat",
  parentReturnPackCode: "AE_VAT201",
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
      id: "fta_vat_current_rate",
      title: "Federal Tax Authority — VAT overview and current 5% rate",
      url: "https://www.tax.gov.ae/en/VAT.aspx",
      asOf: "2026-08-01",
    },
    {
      id: "fta_vat_introduction",
      title: "Federal Tax Authority — VAT guide confirming introduction on 1 January 2018",
      url: "https://tax.gov.ae/DataFolder/Files/Pdf/Financial%20Services%20VAT%20Guide%20VATGFS1%20-%20EN%2007%202019.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "fta_vat201_emaratax",
      title: "Federal Tax Authority — EmaraTax VAT201 returns form user manual",
      url: "https://tax.gov.ae/DownloadOpenTextFile?fileUrl=en%2FVAT_VAT_Guides%2FVAT_Returns_form%2FProcess_the_VAT_201_returns_form_EN.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "fta_vat_return_topics",
      title: "Federal Tax Authority — filing VAT returns and making payments",
      url: "https://tax.gov.ae/en/taxes/Vat/vat.topics/filing.vat.returns.and.making.payments.aspx",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [AE_VAT201_2026],
  returnPackTaxCodes: {
    AE_VAT201: {
      code: "AE-VAT-STD",
      name: "United Arab Emirates standard VAT",
      ratePercent: 5,
      rates: [
        { ratePercent: 5, effectiveFrom: "2018-01-01", sourceId: "fta_vat_introduction" },
      ],
    },
  },
};
