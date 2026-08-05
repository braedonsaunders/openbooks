import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const SG_GST_F5_2026: TaxReturnPack = {
  code: "SG_GSTF5",
  name: "GST F5 Return",
  country: "SG",
  jurisdiction: { code: "SG", name: "Singapore", country: "SG", level: "country", taxType: "gst" },
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/filing-gst/completing-gst-returns",
  watermark: "Working copy — amounts must be in Singapore dollars; review scheme, reverse-charge, and marketplace disclosures before filing in myTax Portal",
  boxes: [
    { lineCode: "1", label: "Total value of standard-rated supplies", sign: 1, sequence: 10 },
    { lineCode: "2", label: "Total value of zero-rated supplies", sign: 1, sequence: 20 },
    { lineCode: "3", label: "Total value of exempt supplies", sign: 1, sequence: 30 },
    { lineCode: "4", label: "Total value of Boxes 1, 2, and 3", sign: 1, sequence: 40, formula: "1 + 2 + 3" },
    { lineCode: "5", label: "Total value of taxable purchases, excluding disallowed input tax", sign: 1, sequence: 50 },
    { lineCode: "6", label: "Output tax due", sign: -1, sequence: 60, basis: "tax_collected", glMap: "sales" },
    { lineCode: "7", label: "Input tax and refunds claimed, excluding disallowed input tax", sign: 1, sequence: 70, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "8", label: "Net GST to be paid to or claimed from IRAS", sign: 1, sequence: 80, formula: "6 - 7" },
    { lineCode: "9", label: "Value of goods imported under import-GST suspension schemes", sign: 1, sequence: 90 },
    { lineCode: "10", label: "GST refunded to tourists and claimed in Box 7", sign: 1, sequence: 100 },
    { lineCode: "11", label: "Bad-debt relief and/or reverse-charge refund claimed in Box 7", sign: 1, sequence: 110 },
    { lineCode: "12", label: "Pre-registration input tax claimed in Box 7", sign: 1, sequence: 120 },
    { lineCode: "13", label: "Revenue for the accounting period", sign: 1, sequence: 130 },
    { lineCode: "14", label: "Imported services and/or low-value goods subject to reverse charge", sign: 1, sequence: 140 },
    { lineCode: "15", label: "Remote services supplied by an electronic marketplace operator for third-party suppliers", sign: 1, sequence: 150 },
  ],
};

/** Singapore GST localization maintained from IRAS rate history and current F5 guidance. */
export const SINGAPORE_TAX_PACK: CountryTaxPackDefinition = {
  code: "SG_INDIRECT_TAX",
  version: "2026.08.01",
  country: "SG",
  name: "Singapore",
  countryTaxType: "gst",
  parentReturnPackCode: "SG_GSTF5",
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
      id: "iras_gst_rate_history",
      title: "IRAS — GST rate history from introduction through the current 9% rate",
      url: "https://www.iras.gov.sg/quick-links/tax-rates/goods-and-services-tax-%28gst%29-rates",
      asOf: "2026-08-01",
    },
    {
      id: "iras_gst_rate_change_2024",
      title: "IRAS — GST rate changes to 8% in 2023 and 9% in 2024",
      url: "https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/gst-rate-change/gst-rate-change-for-consumers1",
      asOf: "2026-08-01",
    },
    {
      id: "iras_gst_f5_2026",
      title: "IRAS — completing GST F5 returns",
      url: "https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/filing-gst/completing-gst-returns",
      asOf: "2026-08-01",
    },
    {
      id: "iras_gst_api_fields",
      title: "IRAS — GST API submission format and F5 field definitions",
      url: "https://apisandbox.iras.gov.sg/iras/devportal/sb/system/files/2024-03/IRAS%20GST%20API%20Submission%20-%20Format%20and%20Front-end%20Validations_v2.1.pdf",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [SG_GST_F5_2026],
  returnPackTaxCodes: {
    SG_GSTF5: {
      code: "SG-GST",
      name: "Singapore GST",
      ratePercent: 9,
      rates: [
        { ratePercent: 3, effectiveFrom: "1994-04-01", effectiveTo: "2002-12-31", sourceId: "iras_gst_rate_history" },
        { ratePercent: 4, effectiveFrom: "2003-01-01", effectiveTo: "2003-12-31", sourceId: "iras_gst_rate_history" },
        { ratePercent: 5, effectiveFrom: "2004-01-01", effectiveTo: "2007-06-30", sourceId: "iras_gst_rate_history" },
        { ratePercent: 7, effectiveFrom: "2007-07-01", effectiveTo: "2022-12-31", sourceId: "iras_gst_rate_history" },
        { ratePercent: 8, effectiveFrom: "2023-01-01", effectiveTo: "2023-12-31", sourceId: "iras_gst_rate_history" },
        { ratePercent: 9, effectiveFrom: "2024-01-01", sourceId: "iras_gst_rate_change_2024" },
      ],
    },
  },
};
