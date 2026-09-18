import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const SA_VAT_RETURN: TaxReturnPack = {
  code: "SA_VAT_RETURN",
  name: "VAT Return — ZATCA portal declaration (الإقرار الضريبي)",
  country: "SA",
  jurisdiction: { code: "SA", name: "Saudi Arabia", country: "SA", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://zatca.gov.sa/en/HelpCenter/CustomerJourney/Pages/tax-journey.aspx",
  watermark: "Working copy — review state-borne supplies, threshold-driven frequency, and corrections treatment, then file through the ZATCA portal",
  boxes: [
    { lineCode: "1", label: "Box 1 — standard-rated domestic sales (15%)", sign: 1, sequence: 10 },
    { lineCode: "2", label: "Box 2 — sales where the State bears the VAT (citizens: private healthcare, private education, qualifying first home)", sign: 1, sequence: 20 },
    { lineCode: "3", label: "Box 3 — zero-rated domestic sales", sign: 1, sequence: 30 },
    { lineCode: "4", label: "Box 4 — exports", sign: 1, sequence: 40 },
    { lineCode: "5", label: "Box 5 — exempt sales", sign: 1, sequence: 50 },
    { lineCode: "6", label: "Box 6 — total sales", sign: 1, sequence: 60 },
    { lineCode: "7", label: "Box 7 — standard-rated domestic purchases (15%)", sign: 1, sequence: 70 },
    { lineCode: "8", label: "Box 8 — imports subject to VAT paid at customs (15%)", sign: 1, sequence: 80 },
    { lineCode: "9", label: "Box 9 — imports subject to VAT accounted for through the reverse charge mechanism (15%)", sign: 1, sequence: 90 },
    { lineCode: "10", label: "Box 10 — zero-rated purchases", sign: 1, sequence: 100 },
    { lineCode: "11", label: "Box 11 — exempt purchases", sign: 1, sequence: 110 },
    { lineCode: "12", label: "Box 12 — total purchases", sign: 1, sequence: 120 },
    { lineCode: "13", label: "Box 13 — total VAT due for the current tax period", sign: -1, sequence: 130 },
    { lineCode: "14", label: "Box 14 — adjustments for previous periods", sign: 1, sequence: 140 },
    { lineCode: "15", label: "Box 15 — VAT credit carried forward from previous periods", sign: 1, sequence: 150 },
    { lineCode: "16", label: "Box 16 — net VAT payable / refundable", sign: -1, sequence: 160 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 170, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 180, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Saudi Arabia VAT (ضريبة القيمة المضافة) localization, maintained from ZATCA sources.
 *
 * Standard rate history is the point of this pack: VAT was introduced at 5% on
 * 1 January 2018 and raised to 15% on 1 July 2020. A pack that only knows 15%
 * silently misprices every 2018–2020 document.
 *
 * Zero-rated supplies (exports, qualifying domestic supplies) carry SA-VAT-ZERO.
 * Exempt supplies (financial services, residential leases) are NOT a 0% code and
 * have no code here. There is no reduced rate.
 *
 * Explicitly out of scope: the SAR 40 million annual-supplies threshold that moves
 * filers between monthly (default) and quarterly filing; registration thresholds;
 * place-of-supply and GCC intra-supply transitional rules (the GCC VAT framework
 * agreement is not modelled as a jurisdiction); box 2 state-borne detail beyond its
 * label; corrections workflow beyond the box 14/15 labels; and FATOORA e-invoicing,
 * which is a separate ZATCA regime and gets no declaration here. VAT is national,
 * so jurisdictions is empty.
 */
export const SAUDI_ARABIA_TAX_PACK: CountryTaxPackDefinition = {
  code: "SA_INDIRECT_TAX",
  version: "2026.08.01",
  country: "SA",
  name: "Saudi Arabia",
  countryTaxType: "vat",
  parentReturnPackCode: "SA_VAT_RETURN",
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
      id: "zatca_retail_vat_guide",
      title: "ZATCA — VAT Guideline for the Retail Sector (15% standard rate; VAT implemented 1 January 2018; return boxes 1–16)",
      url: "https://zatca.gov.sa/en/HelpCenter/guidelines/Documents/Guideline-For-Retail-Sector-under-VAT-Provisions.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "zatca_imports_exports_vat_guide",
      title: "ZATCA — Guideline on Imports and Exports under VAT (5% applied in the pre-increase era; Field 9 reverse charge; export zero-rating)",
      url: "https://zatca.gov.sa/en/HelpCenter/guidelines/Documents/Guideline-on-Imports-and-Exports-under-VAT-Provision.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "zatca_vat_filing_journey",
      title: "ZATCA — VAT Journey: filing the VAT declaration through the ZATCA portal",
      url: "https://zatca.gov.sa/en/HelpCenter/CustomerJourney/Pages/tax-journey.aspx",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [SA_VAT_RETURN],
  returnPackTaxCodes: {
    SA_VAT_RETURN: [
      {
        code: "SA-VAT-STD",
        name: "Saudi Arabia standard VAT",
        ratePercent: 15,
        role: "standard",
        rates: [
          { ratePercent: 5, effectiveFrom: "2018-01-01", effectiveTo: "2020-06-30", sourceId: "zatca_retail_vat_guide" },
          { ratePercent: 15, effectiveFrom: "2020-07-01", sourceId: "zatca_retail_vat_guide" },
        ],
      },
      {
        code: "SA-VAT-ZERO",
        name: "Saudi Arabia zero-rated VAT",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2018-01-01", sourceId: "zatca_imports_exports_vat_guide" }],
      },
    ],
  },
};
