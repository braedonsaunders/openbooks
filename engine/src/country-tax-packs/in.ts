import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const IN_GSTR3B_2026: TaxReturnPack = {
  code: "IN_GSTR3B",
  name: "Form GSTR-3B — summary return",
  country: "IN",
  jurisdiction: { code: "IN", name: "India", country: "IN", level: "country", taxType: "gst" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.gst.gov.in",
  watermark: "Working copy — classify every supply, separate IGST/CGST/SGST/UTGST and cess, review QRMP eligibility, and file on the GST portal",
  boxes: [
    { lineCode: "3.1(a)", label: "Outward taxable supplies other than zero-rated, nil-rated, and exempted", sign: 1, sequence: 10 },
    { lineCode: "3.1(b)", label: "Outward taxable supplies — zero-rated", sign: 1, sequence: 20 },
    { lineCode: "3.1(c)", label: "Other outward supplies — nil-rated and exempted", sign: 1, sequence: 30 },
    { lineCode: "3.1(d)", label: "Inward supplies liable to reverse charge", sign: 1, sequence: 40 },
    { lineCode: "3.1(e)", label: "Non-GST outward supplies", sign: 1, sequence: 50 },
    { lineCode: "3.1.1(i)", label: "Section 9(5) supplies on which the electronic commerce operator pays tax", sign: 1, sequence: 60 },
    { lineCode: "3.1.1(ii)", label: "Section 9(5) supplies made through an electronic commerce operator by the registered person", sign: 1, sequence: 70 },
    { lineCode: "3.2", label: "Inter-State supplies in 3.1(a) to unregistered persons, composition taxable persons, and UIN holders", sign: 1, sequence: 80 },
    { lineCode: "4(A)", label: "ITC available", sign: 1, sequence: 90 },
    { lineCode: "4(B)", label: "ITC reversed", sign: 1, sequence: 100 },
    { lineCode: "4(C)", label: "Net ITC available", sign: 1, sequence: 110 },
    { lineCode: "4(D)", label: "Other ITC information", sign: 1, sequence: 120 },
    { lineCode: "5", label: "Exempt, nil-rated, and non-GST inward supplies", sign: 1, sequence: 130 },
    { lineCode: "5.1", label: "Interest and late fee payable", sign: 1, sequence: 140 },
    { lineCode: "6.1", label: "Payment of tax", sign: 1, sequence: 150 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output GST from the ledger, all tax heads and rates", sign: -1, sequence: 160, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input GST from the ledger, all tax heads and rates", sign: 1, sequence: 170, basis: "tax_paid", glMap: "purchases" },
  ],
};

/** India GST workpaper pack maintained from CBIC and GSTN primary sources. */
export const INDIA_TAX_PACK: CountryTaxPackDefinition = {
  code: "IN_INDIRECT_TAX",
  version: "2026.08.01",
  country: "IN",
  name: "India",
  countryTaxType: "gst",
  parentReturnPackCode: "IN_GSTR3B",
  completeness: {
    jurisdictions: "partial",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "partial",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "cbic_gst_rate_schedule",
      title: "CBIC — GST rates for goods and services, including the 18% schedule",
      url: "https://cbic-gst.gov.in/gst-goods-services-rates.html",
      asOf: "2026-08-01",
    },
    {
      id: "cbic_gst_introduction_2017",
      title: "CBIC — GST revenue press note confirming introduction on 1 July 2017",
      url: "https://cbic-gst.gov.in/pdf/press-release/Fresh%20Press%20note%20on%20GST%20Rev.%20Fif.%20for%20July%2017.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "cbic_gstr3b_form",
      title: "CBIC — CGST Rules forms, Form GSTR-3B",
      url: "https://cbic-gst.gov.in/pdf/18052021-CGST-Rules-2017-Part-B-Forms.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "gstn_gstr3b_311",
      title: "GSTN — Table 3.1.1 added to Form GSTR-3B",
      url: "https://tutorial.gst.gov.in/downloads/news/gstr_3b_sec_9_5_advisory_19_07_22.pdf",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [IN_GSTR3B_2026],
  returnPackTaxCodes: {
    IN_GSTR3B: {
      code: "IN-GST-18",
      name: "India combined GST 18% schedule — classification required",
      ratePercent: 18,
      rates: [
        { ratePercent: 18, effectiveFrom: "2017-07-01", sourceId: "cbic_gst_rate_schedule" },
      ],
    },
  },
};
