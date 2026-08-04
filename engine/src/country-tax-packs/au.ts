import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const AU_BAS_GST: TaxReturnPack = {
  code: "AU_BAS_GST",
  name: "Business Activity Statement — GST",
  country: "AU",
  jurisdiction: { code: "AU", name: "Australia", country: "AU", level: "country", taxType: "gst" },
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/how-to-lodge-your-bas",
  watermark: "Working copy — lodge through ATO online services or enabled business software",
  boxes: [
    { lineCode: "G1", label: "Total sales", sign: 1, sequence: 10 },
    { lineCode: "G2", label: "Export sales", sign: 1, sequence: 20 },
    { lineCode: "G3", label: "Other GST-free sales", sign: 1, sequence: 30 },
    { lineCode: "G10", label: "Capital purchases", sign: 1, sequence: 40 },
    { lineCode: "G11", label: "Non-capital purchases", sign: 1, sequence: 50 },
    { lineCode: "1A", label: "GST on sales", sign: -1, sequence: 60, basis: "tax_collected", glMap: "sales" },
    { lineCode: "1B", label: "GST on purchases", sign: 1, sequence: 70, basis: "tax_paid", glMap: "purchases" },
  ],
};

/** Australia GST localization maintained from Australian Government sources. */
export const AUSTRALIA_TAX_PACK: CountryTaxPackDefinition = {
  code: "AU_INDIRECT_TAX",
  version: "2026.08.01",
  country: "AU",
  name: "Australia",
  countryTaxType: "gst",
  parentReturnPackCode: "AU_BAS_GST",
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
      id: "ato_gst_commencement",
      title: "ATO GST Bulletin 2000/1 — GST commencement at 10%",
      url: "https://www.ato.gov.au/law/view/pdf?DocId=GSB%2FGSTB20001%2FNAT%2FATO%2F00001&filename=law%2Fview%2Fpdf%2Fbul%2Fgstb2000-001.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "ato_bas_full_reporting",
      title: "ATO — GST full reporting labels for a business activity statement",
      url: "https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/lodging-your-bas-or-annual-gst-return/options-for-reporting-and-paying-gst/monthly-gst-reporting",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [AU_BAS_GST],
  returnPackTaxCodes: {
    AU_BAS_GST: {
      code: "AU-GST",
      name: "Australia GST",
      ratePercent: 10,
      rates: [{ ratePercent: 10, effectiveFrom: "2000-07-01", sourceId: "ato_gst_commencement" }],
    },
  },
};
