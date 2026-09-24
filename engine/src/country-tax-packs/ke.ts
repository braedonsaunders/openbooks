import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const KE_VAT3_2026: TaxReturnPack = {
  code: "KE_VAT3",
  name: "VAT3 — Value Added Tax Return",
  country: "KE",
  jurisdiction: { code: "KE", name: "Kenya — national VAT territory", country: "KE", level: "country", taxType: "vat" },
  // KRA's filing guidance describes the VAT3 as a return FORM filled online
  // via iTax ("VAT returns are filed online via iTax ... by filling a VAT3
  // Return form"), due on or before the 20th of the following month — hence
  // monthly frequency with portal-manual entry, not a file upload.
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://itax.kra.go.ke",
  watermark: "Working copy — confirm the VAT3 lines against the iTax return before filing; turnover tax and Digital Service Tax are separate obligations",
  // No numeric line numbers are published on any fetchable KRA page (the
  // form itself lives inside iTax), so the return's section NAMES are used
  // as codes. Inventing numeric codes would be worse than naming them. The
  // vocabulary below is KRA's own: output tax, zero-rated supplies, input
  // tax, withholding VAT credits, excess input tax brought forward, and tax
  // payable or credit carried forward.
  boxes: [
    { lineCode: "OUTPUT_TAX", label: "Output tax on taxable supplies at the general rate", sign: -1, sequence: 10 },
    { lineCode: "ZERO_RATED_SUPPLIES", label: "Zero-rated supplies (Second Schedule) at 0%", sign: 1, sequence: 20 },
    { lineCode: "INPUT_TAX", label: "Input tax on taxable purchases and imports", sign: 1, sequence: 30 },
    { lineCode: "WITHHOLDING_VAT", label: "Withholding VAT credits applied against tax payable", sign: 1, sequence: 40 },
    { lineCode: "EXCESS_INPUT_BF", label: "Excess input tax brought forward from the prior period", sign: 1, sequence: 50 },
    { lineCode: "TAX_PAYABLE_CREDIT_CF", label: "Tax payable, or credit carried forward where input exceeds output", sign: 1, sequence: 60 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 70, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 80, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Kenya VAT localization. Amounts in Kenyan shilling (KES); the pack
 * contract declares no currency channel, so this stays a comment.
 *
 * Standard-rate history is the COVID window: KRA cut VAT from 16% to 14%
 * with effect from 1 April 2020 (public notice 02/04/2020 on Legal Notice
 * No. 35 of 2020) and restored 16% with effect from 1 January 2021 (public
 * notice 04/01/2021, "replacing those introduced in April 2020"), so the
 * 14% interval closes 2020-12-31. Both window endpoints are KRA-sourced.
 *
 * Left-truncated: the pre-window 16% regime (the VAT Act 2013 era) has no
 * source-attested start date from this vantage, so the history opens at
 * 2020-04-01 as applicability, not origin. Kenya Law (kenyalaw.org and
 * new.kenyalaw.org) answered 403 to direct fetches — origin refused, not
 * absent; retry from another vantage — and gazette.go.ke did not resolve
 * from this sandbox (000: no answer here, not evidence the host is gone).
 * Someone who can reach the Act should extend the first interval back and
 * re-title the source from applicability to origin.
 *
 * Refused by name: the 8% petroleum-products rate under the Finance Act
 * 2018. KRA states it applied only prior to 1 July 2023 and was deleted
 * by the Finance Act 2023, so no code is declared for it.
 *
 * Zero-rated supplies (Second Schedule, e.g. exports) carry 0% WITH
 * input-tax recovery; exempt supplies (First Schedule) are NOT zero-rated
 * — their input tax is not deductible — and no exempt code is declared.
 * Out of scope by declaration: the Digital Service Tax and the turnover
 * tax are separate obligations and neither is modelled nor declared. VAT
 * is national, so no subnational jurisdictions are declared.
 */
export const KENYA_TAX_PACK: CountryTaxPackDefinition = {
  code: "KE_INDIRECT_TAX",
  version: "2026.08.01",
  country: "KE",
  name: "Kenya",
  countryTaxType: "vat",
  parentReturnPackCode: "KE_VAT3",
  completeness: {
    jurisdictions: "not_applicable",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "kra_vat_overview",
      title: "KRA — VAT overview: 16% general rate, 0% Second Schedule zero rate (page states no origin date — cited as applicability), First Schedule exempt supplies, 8% petroleum rate deleted by the Finance Act 2023",
      url: "https://www.kra.go.ke/individual/filing-paying/types-of-taxes/value-added-tax",
      asOf: "2026-09-18",
    },
    {
      id: "kra_vat3_filing",
      title: "KRA — VAT returns are filed by filling the VAT3 Return form online via iTax, due on or before the 20th of the following month",
      url: "https://www.kra.go.ke/business/companies-partnerships/companies-partnerships-pin-taxes/companies-partnerships-file-pay",
      asOf: "2026-09-18",
    },
    {
      id: "kra_notice_ln35_2020",
      title: "KRA public notice 02/04/2020 — Legal Notice No. 35 of 2020 cut VAT from 16% to 14% with effect from 1st April 2020; the 2020-12-31 close is set by the January 2021 restoration notice",
      url: "https://www.kra.go.ke/news-center/public-notices/807-tax-legislative-changes-contained-in-legal-notice-no-35-of-2020-and-business-laws-amendment-act,-2020",
      asOf: "2026-09-18",
    },
    {
      id: "kra_notice_rate_change_2021",
      title: "KRA public notice 04/01/2021 — VAT back to 16% with effect from 1st January 2021, replacing the April 2020 rates; first return under the new rate due 20th February 2021",
      url: "https://www.kra.go.ke/news-center/public-notices/1042-change-of-tax-rates",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [KE_VAT3_2026],
  returnPackTaxCodes: {
    KE_VAT3: [
      {
        code: "KE-VAT-STD",
        name: "Kenya VAT standard rate",
        ratePercent: 16,
        role: "standard",
        rates: [
          { ratePercent: 14, effectiveFrom: "2020-04-01", effectiveTo: "2020-12-31", sourceId: "kra_notice_ln35_2020" },
          { ratePercent: 16, effectiveFrom: "2021-01-01", sourceId: "kra_notice_rate_change_2021" },
        ],
        // The VAT3 names the "general rate" in words, not numbers.
        returnBoxes: ["OUTPUT_TAX"],
      },
      {
        code: "KE-VAT-ZERO",
        name: "Kenya VAT zero rate — Second Schedule supplies",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2020-04-01", sourceId: "kra_vat_overview" }],
      },
    ],
  },
};
