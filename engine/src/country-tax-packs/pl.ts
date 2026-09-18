import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const PL_JPK_V7M_2026: TaxReturnPack = {
  code: "PL_JPK_V7M",
  name: "JPK_V7M — JPK_VAT z deklaracją (rozliczenie miesięczne)",
  country: "PL",
  jurisdiction: { code: "PL", name: "Poland", country: "PL", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "file_upload",
  governmentFormat: "certified_file",
  submissionUrl: "https://www.podatki.gov.pl/podatki-firmowe/jednolity-plik-kontrolny/jpk_vat-z-deklaracja",
  watermark: "Working copy — lodge schema-validated XML through e-Urząd Skarbowy; filer confirms KSeF e-invoicing treatment separately",
  boxes: [
    { lineCode: "P_19", label: "P_19 — taxable base for domestic supplies at 22%/23% (standard rate)", sign: 1, sequence: 10 },
    { lineCode: "P_20", label: "P_20 — output tax on domestic supplies at 22%/23% (standard rate)", sign: -1, sequence: 20 },
    { lineCode: "P_17", label: "P_17 — taxable base for domestic supplies at 7%/8%", sign: 1, sequence: 30 },
    { lineCode: "P_18", label: "P_18 — output tax on domestic supplies at 7%/8%", sign: -1, sequence: 40 },
    { lineCode: "P_15", label: "P_15 — taxable base for domestic supplies at 5%", sign: 1, sequence: 50 },
    { lineCode: "P_16", label: "P_16 — output tax on domestic supplies at 5%", sign: -1, sequence: 60 },
    { lineCode: "P_13", label: "P_13 — taxable base for domestic supplies at 0%", sign: 1, sequence: 70 },
    { lineCode: "P_38", label: "P_38 — aggregate output tax", sign: -1, sequence: 80 },
    { lineCode: "P_48", label: "P_48 — aggregate deductible input tax", sign: 1, sequence: 90 },
    { lineCode: "P_51", label: "P_51 — tax to be remitted to the tax office", sign: 1, sequence: 100 },
    { lineCode: "P_62", label: "P_62 — excess of input tax over output tax carried forward", sign: 1, sequence: 110 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all rates", sign: -1, sequence: 120, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all rates", sign: 1, sequence: 130, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Poland VAT (podatek od towarów i usług) localization.
 *
 * Since 1 October 2020 the declaration and the records are a single JPK_VAT
 * file — there is no separate VAT-7 return. JPK_V7M is the monthly variant
 * declared here; JPK_V7K (quarterly) is out of scope for this pack, as is the
 * KSeF mandatory e-invoicing regime. VAT is national: no voivodeship levy is
 * declared.
 *
 * Rate tails below are left-truncated at the cited applicability sources, not
 * origins: the standard 23% (and 8%) rate applies since 1 January 2011,
 * raised by 1pp from 22% (and 7%); the 5% band arrived with the same 2011
 * reform; 0% zero-rating for exports and intra-EU supplies is carried at the
 * 2004 VAT Act applicability. Earlier history is refused as partial.
 *
 * Refused by name: the 2022–2024 tarcza antyinflacyjna temporary windows
 * (zero-rated basic foodstuffs, cut energy rates) — a temporary rate is only
 * transcribed with both the opening and closing ordinances sourced, which was
 * not done here.
 *
 * Sourcing refusal: the 5% band's 2011 origin rested solely on the OECD
 * Consumption Tax Trends summary, so the schedule now opens at the MF List
 * of VAT rates publication (13.12.2021) instead — the MF Sejm reply on the
 * 23%/8% mechanism does not mention the 5% band. Shorter MF-sourced
 * history beats a longer OECD-sourced one.
 */
export const POLAND_TAX_PACK: CountryTaxPackDefinition = {
  code: "PL_INDIRECT_TAX",
  version: "2026.08.01",
  country: "PL",
  name: "Poland",
  countryTaxType: "vat",
  parentReturnPackCode: "PL_JPK_V7M",
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
      id: "mf_jpk_vat_monthly_quarterly",
      title: "Ministerstwo Finansów (KAS) — JPK_VAT z deklaracją: JPK_V7M monthly, JPK_V7K quarterly",
      url: "https://www.podatki.gov.pl/podatki-firmowe/jednolity-plik-kontrolny/jpk_vat-z-deklaracja",
      asOf: "2026-09-18",
    },
    {
      id: "mf_jpk_vat_brochure_en",
      title: "Ministerstwo Finansów — JPK_VAT with declaration information brochure (English): declaration fields P_10 to P_68 applicability",
      url: "https://www.podatki.gov.pl/media/bq2gbb34/broszura-informacyjna-jpk_vat-z-deklaracj%C4%85-wersja-angloj%C4%99zyczna_20230201.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "mf_vat_rate_mechanism_2024",
      title: "Ministerstwo Finansów reply to Sejm interpellation 2178 — 23%/8% rates raised 1pp versus pre-1-January-2011 22%/7%",
      url: "https://api.sejm.gov.pl/sejm/term10/interpellations/attachment/ATTD4FH4W/i02178-o1.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "mf_vat_rates_list_2021",
      title: "Ministerstwo Finansów — List of VAT rates (13.12.2021): standard 23%, reduced 8%/5%/0%; 5% for Annex 10 goods (applicability, not origin)",
      url: "https://podatki-arch.mf.gov.pl/en/value-added-tax/general-vat-rules-and-rates/list-of-vat-rates/",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [PL_JPK_V7M_2026],
  returnPackTaxCodes: {
    PL_JPK_V7M: [
      {
        code: "PL-VAT-STD",
        name: "Poland standard VAT",
        ratePercent: 23,
        role: "standard",
        rates: [{ ratePercent: 23, effectiveFrom: "2011-01-01", sourceId: "mf_vat_rate_mechanism_2024" }],
      },
      {
        code: "PL-VAT-RED8",
        name: "Poland reduced VAT 8%",
        ratePercent: 8,
        role: "reduced",
        rates: [{ ratePercent: 8, effectiveFrom: "2011-01-01", sourceId: "mf_vat_rate_mechanism_2024" }],
      },
      {
        code: "PL-VAT-RED5",
        name: "Poland reduced VAT 5%",
        ratePercent: 5,
        role: "reduced",
        rates: [{ ratePercent: 5, effectiveFrom: "2021-12-13", sourceId: "mf_vat_rates_list_2021" }],
      },
      {
        code: "PL-VAT-ZERO",
        name: "Poland zero-rated VAT (exports, intra-EU supplies)",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2004-05-01", sourceId: "mf_jpk_vat_brochure_en" }],
      },
    ],
  },
};
