import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const DK_MOMS_2026: TaxReturnPack = {
  code: "DK_MOMS",
  name: "Momsangivelse — momsindberetning 2026",
  country: "DK",
  jurisdiction: { code: "DK", name: "Denmark — moms territory", country: "DK", level: "country", taxType: "vat" },
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://skat.dk/en-us/businesses/vat/vat-what-to-do/how-to-file-your-vat-return",
  watermark: "Working copy — review EU-acquisition and reverse-charge treatment, then file through TastSelv Erhverv",
  boxes: [
    { lineCode: "SALGSMOMS", label: "Salgsmoms — output VAT (udgående moms) on domestic sales", sign: -1, sequence: 10, basis: "tax_collected", glMap: "sales" },
    { lineCode: "EU_VAREKOEB_MOMS", label: "Moms af EU-varekøb — VAT on acquisitions of goods from other EU countries", sign: -1, sequence: 20 },
    { lineCode: "UDLAND_YDELSER_MOMS", label: "Moms af ydelser købt i udlandet med omvendt betalingspligt — VAT on services purchased abroad under reverse charge", sign: -1, sequence: 30 },
    { lineCode: "KOEBSMOMS", label: "Købsmoms — deductible input VAT (indgående moms) on purchases", sign: 1, sequence: 40, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "MOMSRESULTAT", label: "Moms til betaling eller tilgodehavende — VAT payable or refundable", sign: 1, sequence: 50, formula: "SALGSMOMS+EU_VAREKOEB_MOMS+UDLAND_YDELSER_MOMS-KOEBSMOMS" },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 60, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 70, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Denmark moms localization, sourced from skat.dk (Skattestyrelsen).
 *
 * The momsindberetning is lodged through TastSelv Erhverv (E-tax for
 * businesses) at skat.dk. The settlement period follows turnover — monthly
 * above DKK 50 million, quarterly for newly registered businesses and
 * DKK 5–50 million turnover, half-yearly below DKK 5 million — so the pack
 * keeps the quarterly default and does not model the thresholds.
 *
 * Box line codes are the return's field NAMES: the TastSelv Erhverv portal
 * form publishes named fields, not numeric line codes, so there is no
 * agency-published numbering to transcribe.
 *
 * Denmark has no reduced VAT rate — one of very few EU states without one —
 * so the return carries only the 25% standard code. That single code runs
 * back to 1992-01-01 as one open row, sourced to the act itself: LOV nr 891
 * af 21/12/1991 (Tillægsmoms på 3 pct.), read in full at retsinformation.dk.
 * - Operative text, verbatim: § 2 nr. 3 — »I § 14 ændres »22 pct.« til:
 *   »22 + 3 pct.«« — with § 5 Stk. 1 (»Loven træder i kraft den 1. januar
 *   1992«) and Stk. 3 (§ 2 applies to supplies »fra og med den 1. januar
 *   1992«). Note the drafting quirk: Denmark wrote the change as base 22
 *   PLUS a 3-point supplement (the tillægsmoms of the act's title), so § 14
 *   reads "22 + 3 pct.", not "25 pct." — the effective standard rate is 25%.
 *   skat.dk's current 25% page corroborates the tail.
 * - The 22% predecessor is identified but not transcribed: § 14 held 22%
 *   before this change, but no start date for the 22% era is attested, so
 *   no 22% row is added.
 * Zero-rated newspaper supplies are NOT declared as a code: no agency source
 * for the zero band was fetched. Exempt supplies (health, education,
 * passenger transport and the like) are not a 0% code.
 *
 * Moms is national. Greenland and the Faroe Islands are outside the Danish
 * VAT area entirely; they are not jurisdictions of this pack and there is no
 * separate pack for them.
 */
export const DENMARK_TAX_PACK: CountryTaxPackDefinition = {
  code: "DK_INDIRECT_TAX",
  version: "2026.08.01",
  country: "DK",
  name: "Denmark",
  countryTaxType: "vat",
  parentReturnPackCode: "DK_MOMS",
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
      id: "skat_dk_vat_rate_25",
      title: "skat.dk — Get started on VAT: the Danish VAT rate is generally 25% (current applicability corroboration for the tail)",
      url: "https://skat.dk/en-us/businesses/vat/get-started-on-vat",
      asOf: "2026-09-18",
    },
    {
      id: "lov_891_1991_tillaegsmoms",
      title: "LOV nr 891 af 21/12/1991 (Tillægsmoms på 3 pct.), retsinformation.dk ELI: § 2 nr. 3 amends § 14 »22 pct.« to »22 + 3 pct.« (effective rate 25%); § 5 Stk. 1 in force 1 January 1992, Stk. 3 applies § 2 to supplies from 1 January 1992",
      url: "https://www.retsinformation.dk/eli/lta/1991/891",
      asOf: "2026-09-18",
    },
    {
      id: "skat_dk_file_vat_return",
      title: "skat.dk — How to file your VAT return: file in E-tax for businesses (TastSelv Erhverv)",
      url: "https://skat.dk/en-us/businesses/vat/vat-what-to-do/how-to-file-your-vat-return",
      asOf: "2026-09-18",
    },
    {
      id: "skat_dk_vat_deadlines",
      title: "skat.dk — VAT deadlines: monthly, quarterly, and half-yearly settlement by turnover; quarterly for newly registered businesses",
      url: "https://skat.dk/en-us/businesses/vat/deadlines-filing-vat-returns-and-paying-vat",
      asOf: "2026-09-18",
    },
    {
      id: "skat_dk_vat_deductions",
      title: "skat.dk — VAT deductions: deduct input VAT on business purchases; refund after filing the VAT return",
      url: "https://skat.dk/en-us/businesses/vat/vat-deductions?oid=2131494",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [DK_MOMS_2026],
  returnPackTaxCodes: {
    DK_MOMS: [
      {
        code: "DK-VAT-STD",
        name: "Denmark standard moms",
        role: "standard",
        ratePercent: 25,
        rates: [{ ratePercent: 25, effectiveFrom: "1992-01-01", sourceId: "lov_891_1991_tillaegsmoms" }],
      },
    ],
  },
};
