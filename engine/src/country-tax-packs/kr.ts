import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const KR_VAT_RETURN_2026: TaxReturnPack = {
  code: "KR_VAT_RETURN",
  name: "VAT Return (부가가치세 신고) — filed through NTS Hometax",
  country: "KR",
  jurisdiction: { code: "KR", name: "Korea — national VAT territory", country: "KR", level: "country", taxType: "vat" },
  // Korea's taxable period is SEMI-ANNUAL, but every general taxable person
  // lodges QUARTERLY: a preliminary return for the first quarter of each
  // half-year (Jan-Mar, Jul-Sep) plus a finalized return for the second
  // quarter (Apr-Jun, Oct-Dec), each due by the 25th of the following month.
  // defaultFrequency "quarterly" therefore models the compulsory preliminary
  // return inside a semi-annual taxable period — not a simple quarterly VAT.
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://nts.go.kr/english/na/ntt/selectNttInfo.do?nttSn=78081&mi=",
  watermark: "Working copy — confirm general vs simplified taxpayer status and taxable-period mapping, then file through NTS Hometax",
  // The English NTS material describes the return's LINES (output tax on
  // taxable supplies, zero-rated supplies, input tax, tax payable or
  // refundable) but publishes no numeric line numbers, so the line NAMES are
  // used as codes. Inventing numeric codes would be worse than naming them.
  boxes: [
    { lineCode: "OUTPUT_TAX", label: "Output tax on taxable supplies at 10%", sign: -1, sequence: 10 },
    { lineCode: "ZERO_RATED_SUPPLIES", label: "Zero-rated supplies — exports and qualifying overseas services at 0%", sign: 1, sequence: 20 },
    { lineCode: "INPUT_TAX", label: "Input tax deductible from output tax", sign: 1, sequence: 30 },
    { lineCode: "TAX_PAYABLE_REFUNDABLE", label: "Tax payable (refundable) — output tax minus input tax", sign: 1, sequence: 40 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 50, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 60, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Korea VAT (부가가치세 / bugagachise) localization.
 *
 * Zero-rated supplies (exports, qualifying overseas services) carry a 0% rate
 * with input-tax refund — they are NOT the same as exempt supplies (e.g.
 * unprocessed foodstuffs, medical services), whose suppliers have no filing
 * obligation and recover no input tax. No exempt code is declared here.
 *
 * Out of scope by declaration: the separate local consumption tax and the
 * simplified-taxpayer regime are neither modelled nor declared.
 *
 * Rate history is left-truncated: the 10% rate has been flat for decades, but
 * the cited MOEF booklet is the 2024 applicability publication, so both
 * schedules open at 2024-01-01 as applicability, not origin.
 *
 * Sourcing refusal: the previous citation ("Taxation in Korea 2022" via a
 * KOTRA archive URL, titled as an NTS publication) was doubly wrong — the
 * file is KOTRA material 22-008, a KOTRA booklet, not an NTS publication,
 * and the host is an archive mirror. It was replaced with the Ministry of
 * Economy and Finance's own KOREAN TAXATION 2024, which states the 10%
 * rate, the zero-rating scope and the output-minus-input calculation
 * directly. No NTS-hosted page stating the 10% rate was found (rechecked
 * 2026-09-18: the English NTS guidance page nttSn=78081 covers filing
 * penalties, not rates; older MOEF booklets use opaque FileDown URLs no
 * index names).
 */
export const KOREA_TAX_PACK: CountryTaxPackDefinition = {
  code: "KR_INDIRECT_TAX",
  version: "2026.08.01",
  country: "KR",
  name: "Korea",
  countryTaxType: "vat",
  parentReturnPackCode: "KR_VAT_RETURN",
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
      id: "nts_vat_filing_periods",
      title: "NTS — VAT taxable period and filing schedule (semi-annual period, quarterly preliminary and finalized returns)",
      url: "https://nts.go.kr/english/na/ntt/selectNttInfo.do?nttSn=78081&mi=",
      asOf: "2026-08-01",
    },
    {
      id: "moef_korean_taxation_2024",
      title: "MOEF — KOREAN TAXATION 2024: VAT rate 10%, zero-rating for exports etc. with refundable input tax, output-minus-input calculation (applicability, not origin)",
      url: "https://mofe.go.kr/com/cmm/fms/FileDown.do?atchFileId=ATCH_000000000028183&fileSn=1",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [KR_VAT_RETURN_2026],
  returnPackTaxCodes: {
    KR_VAT_RETURN: [
      {
        code: "KR-VAT-STD",
        name: "Korea VAT standard rate",
        ratePercent: 10,
        role: "standard",
        rates: [{ ratePercent: 10, effectiveFrom: "2024-01-01", sourceId: "moef_korean_taxation_2024" }],
      },
      {
        code: "KR-VAT-ZERO",
        name: "Korea VAT zero rate — exports and qualifying overseas services",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2024-01-01", sourceId: "moef_korean_taxation_2024" }],
      },
    ],
  },
};
