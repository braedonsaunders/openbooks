import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const TH_PP30_2026: TaxReturnPack = {
  code: "TH_PP30",
  name: "ภ.พ.30 (P.P.30) — Value Added Tax Return",
  country: "TH",
  jurisdiction: { code: "TH", name: "Thailand — VAT territory", country: "TH", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://efiling.rd.go.th/rd-cms/",
  watermark: "Working copy — VAT is 7% by annually-renewed decree through 30 Sep 2026; confirm the successor decree, then file through Revenue Department e-Filing",
  boxes: [
    { lineCode: "1", label: "Item 1 — sales amount this month (7%, 0% and section-81-exempt sales)", sign: 1, sequence: 10 },
    { lineCode: "2", label: "Item 2 — less sales subject to 0% tax rate", sign: 1, sequence: 20 },
    { lineCode: "3", label: "Item 3 — less exempted sales (section 81)", sign: 1, sequence: 30 },
    { lineCode: "4", label: "Item 4 — taxable sales amount (1 - 2 - 3)", sign: 1, sequence: 40 },
    { lineCode: "5", label: "Item 5 — this month's output tax", sign: -1, sequence: 50, basis: "tax_collected", glMap: "sales" },
    { lineCode: "6", label: "Item 6 — purchase amount eligible for input-tax deduction", sign: 1, sequence: 60 },
    { lineCode: "7", label: "Item 7 — this month's input tax", sign: 1, sequence: 70, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "8", label: "Item 8 — this month's tax payable (output exceeds input)", sign: 1, sequence: 80 },
    { lineCode: "9", label: "Item 9 — this month's excess tax (input exceeds output)", sign: 1, sequence: 90 },
    { lineCode: "10", label: "Item 10 — excess tax carried forward from last month", sign: 1, sequence: 100 },
    { lineCode: "11", label: "Item 11 — net tax payable", sign: 1, sequence: 110 },
    { lineCode: "12", label: "Item 12 — net excess tax payable", sign: 1, sequence: 120 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 130, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 140, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Thailand VAT (ภาษีมูลค่าเพิ่ม) localization. Currency is THB; the pack
 * carries no currency field. VAT is national — jurisdictions is empty.
 *
 * The interesting thing about this pack is the sunset. The Revenue Code sets
 * VAT at 10%, but a royal decree has held the collected rate at 7% (6.3% VAT
 * + 0.7% local tax) continuously since 1997, renewed roughly every year or
 * two with an explicit expiry date. The 10% is the rate that would apply if a
 * decree lapsed; it is never declared here as a current rate. The standard
 * schedule below is the contiguous tail this sandbox could source: three
 * closed 7% bands from 1 Oct 2023 to 30 Sep 2026, each dated from the Revenue
 * Department press release that announced its Cabinet-approved draft decree.
 * Earlier decree windows are not transcribed — the history left-truncates at
 * 2023-10-01 rather than guessing an origin date.
 *
 * Sourcing refusals, named so the next person can finish them instead of
 * re-discovering them: the gazetted decree texts live on
 * ratchakitcha.soc.go.th, which answered 403 from this sandbox (origin
 * refused — blocked, not absent; retry from another vantage). Band dates are
 * therefore titled as applicability per the cited release, not as the legal
 * instrument's origin. Non-authority secondary coverage reports a further
 * one-year extension past 30 Sep 2026, but no authority page fetched from
 * here attests it, so the schedule ends 2026-09-30: after that date the
 * covers-today guard fails until the successor is transcribed, and that
 * failure is the intended signal, not a defect.
 *
 * Filing: P.P.30 is a monthly return (items 1–16 on the official
 * instructions). Items 13–16 (surcharge and penalty on late or additional
 * filing) are not transcribed. e-Filing at efiling.rd.go.th is a
 * member-login web portal with RD Prep upload and document submission — no
 * API surface appears on the fetched portal page — hence portal_manual /
 * portal_entry. Specific Business Tax (banking, finance, real estate) is a
 * separate tax outside this VAT pack: named here, nothing declared.
 */
export const THAILAND_TAX_PACK: CountryTaxPackDefinition = {
  code: "TH_INDIRECT_TAX",
  version: "2026.08.01",
  country: "TH",
  name: "Thailand",
  countryTaxType: "vat",
  parentReturnPackCode: "TH_PP30",
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
      id: "rd_pp30_form",
      title: "Revenue Department — P.P.30 VAT return form, Internet-filing version (items 1–16)",
      url: "https://www.rd.go.th/fileadmin/download/english_form/frm_pp30.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "rd_pp30_instructions",
      title: "Revenue Department — P.P.30 filling and filing instructions (monthly filing, items 1–16)",
      url: "https://rd.go.th/fileadmin/download/english_form/pp30_100254.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "rd_news_32_2566",
      title: "Revenue Department press release 32/2566 — 7% VAT applicability 1 Oct 2023–30 Sep 2024 (Cabinet-approved draft decree; Gazette text not fetched from here)",
      url: "https://www.rd.go.th/fileadmin/user_upload/news/2566thai/news32_2566.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "rd_news_29_2567",
      title: "Revenue Department press release 29/2567 — 7% VAT applicability 1 Oct 2024–30 Sep 2025 (Cabinet-approved draft decree; Gazette text not fetched from here)",
      url: "https://rd.go.th/fileadmin/user_upload/lorkhor/newsbanner/2024/9/PR_VAT_17092567.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "rd_news_34_2568",
      title: "Revenue Department press release 34/2568 — 7% VAT applicability 1 Oct 2025–30 Sep 2026 (Cabinet-approved draft decree; Gazette text not fetched from here)",
      url: "https://rd.go.th/fileadmin/user_upload/news/2568thai/news34_2568.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "rd_news_4_2019_en",
      title: "Revenue Department News 4/2019 — statutory 10% under the Revenue Code reduced to 7% (6.3% VAT + 0.7% local tax) by royal decree",
      url: "https://www.rd.go.th/fileadmin/user_upload/news/englishnews04_2562.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "rd_efiling_portal",
      title: "Revenue Department e-Filing portal — member-login online filing with RD Prep upload; no API surface",
      url: "https://efiling.rd.go.th/rd-cms/",
      asOf: "2026-09-18",
    },
    {
      id: "rd_por97_zero_exports",
      title: "Revenue Department Departmental Order Por 97/2543 — export of goods at zero rate under Section 80/1 (ordered 7 Feb 2000)",
      url: "https://www.rd.go.th/fileadmin/user_upload/kormor/eng/RDO_97.pdf",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [TH_PP30_2026],
  returnPackTaxCodes: {
    TH_PP30: [
      {
        code: "TH-VAT-STD",
        name: "Thailand standard VAT (7% by decree; 10% statutory)",
        ratePercent: 7,
        role: "standard",
        rates: [
          { ratePercent: 7, effectiveFrom: "2023-10-01", effectiveTo: "2024-09-30", sourceId: "rd_news_32_2566" },
          { ratePercent: 7, effectiveFrom: "2024-10-01", effectiveTo: "2025-09-30", sourceId: "rd_news_29_2567" },
          { ratePercent: 7, effectiveFrom: "2025-10-01", effectiveTo: "2026-09-30", sourceId: "rd_news_34_2568" },
        ],
      },
      {
        code: "TH-VAT-ZERO",
        name: "Thailand zero-rated VAT on exports (Section 80/1)",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2000-02-07", sourceId: "rd_por97_zero_exports" }],
      },
    ],
  },
};
