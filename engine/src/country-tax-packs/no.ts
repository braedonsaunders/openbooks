import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const NO_MVA_MELDING_2026: TaxReturnPack = {
  code: "NO_MVA_MELDING",
  name: "Skattemelding for merverdiavgift",
  country: "NO",
  jurisdiction: { code: "NO", name: "Norway — MVA territory", country: "NO", level: "country", taxType: "vat" },
  defaultFrequency: "bimonthly",
  submissionChannel: "efile_api",
  governmentFormat: "api",
  submissionUrl: "https://www.skatteetaten.no/bedrift-og-organisasjon/avgifter/mva/mva-melding/",
  watermark: "Working copy — file through Altinn/Skatteetaten from accounting software; territorial exclusions and filer eligibility require review",
  boxes: [
    { lineCode: "3", label: "3 — Salg og uttak av varer og tjenester (høy sats 25%)", sign: 1, sequence: 10 },
    { lineCode: "31", label: "31 — Salg og uttak av varer og tjenester (middels sats 15% næringsmidler)", sign: 1, sequence: 20 },
    { lineCode: "33", label: "33 — Salg og uttak av varer og tjenester (lav sats 12%)", sign: 1, sequence: 30 },
    { lineCode: "32", label: "32 — Salg av fisk og andre marine viltlevende ressurser (11,11%)", sign: 1, sequence: 40 },
    { lineCode: "5", label: "5 — Salg og uttak av varer og tjenester fritatt for merverdiavgift (nullsats)", sign: 1, sequence: 50 },
    { lineCode: "6", label: "6 — Salg og uttak av varer og tjenester unntatt merverdiavgiftsloven", sign: 1, sequence: 60 },
    { lineCode: "1", label: "1 — Kjøp av varer og tjenester med fradragsrett (høy sats 25%)", sign: 1, sequence: 70 },
    { lineCode: "11", label: "11 — Kjøp av varer og tjenester med fradragsrett (middels sats 15%)", sign: 1, sequence: 80 },
    { lineCode: "13", label: "13 — Kjøp av varer og tjenester med fradragsrett (lav sats 12%)", sign: 1, sequence: 90 },
    { lineCode: "12", label: "12 — Kjøp av fisk og andre marine viltlevende ressurser (11,11%)", sign: 1, sequence: 100 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all rates", sign: -1, sequence: 110, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all rates", sign: 1, sequence: 120, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Norway MVA (merverdiavgift) localization. MVA is national: Svalbard and Jan
 * Mayen are outside the Norwegian VAT area and this pack declares nothing for
 * them. Currency is NOK; the pack schema carries no currency field.
 *
 * Line codes are the SAF-T-aligned mvaKode values of the skattemelding inngående/
 * utgående specification (Skatteetaten mva-meldingen code list), not the
 * pre-2022 numbered lines. Since 2022 the return is submitted through the
 * Altinn/Skatteetaten API from accounting software; the standard period is six
 * two-month terms a year (`bimonthly`).
 *
 * Rate history runs back to 2012-01-01 on all three main bands. Each year's
 * band is cited to Skatteetaten's own year-table page for that year
 * (`satser/merverdiavgift/?year=`), which states the general, food and low
 * rates applicable that year: 25% throughout; food 15% throughout; low 8%
 * (2012–2015), 10% (2016–2017), 12% (2018 onward, outside the 2020–2021
 * window below). The 2016 year page additionally narrates the 14 December
 * 2015 Storting decision raising the low rate from 8% to 10% for 2016, which
 * pins the 2015/2016 boundary; the other year-turn boundaries rest on the
 * pairwise year tables (Norway's annual rates change at year turns; mid-year
 * changes are narrated separately, as the 2016 and 2020 cases show).
 *
 * The temporary 12%-to-6% low-rate cut of 2020–2021 IS transcribed: both
 * endpoints (from 1 April 2020 to 30 September 2021) are stated on
 * Skatteetaten's own 2020 and 2021 year-table pages, so the earlier refusal
 * is lifted and the cut sits as a closed window on NO-VAT-PASSENGER. The
 * 15% band also covers water/sewage per the 2026 decision but no separate
 * code is declared for it — code 31 carries the whole middels band.
 *
 * Named refusals: pre-2012 history is not transcribed. Skatteetaten serves
 * no year-table pages for 2008–2011, so the gap cannot be bridged; the 2007
 * page (25/14/8) was read but is isolated by that gap and is left out rather
 * than bridged. The 11.11% fish band is transcribed only for 2025 (annual
 * Storting decision): the 2020 and 2023 decisions were read and also state
 * 11.11%, but the 2021, 2022 and 2024 decisions have not been located yet,
 * so those verified bands stay out until the chain connects.
 *
 * SOURCING: `saft_mva_koder` (Skatteetaten's own SAF-T code specification for
 * the mva-meldingen return, published on the agency's GitHub) is a named
 * id-specific exception in the wave5 proof — primary-in-substance on a
 * non-government host. Lovdata is the official Norwegian legislation
 * database and needs no exception.
 */
export const NORWAY_TAX_PACK: CountryTaxPackDefinition = {
  code: "NO_INDIRECT_TAX",
  version: "2026.08.01",
  country: "NO",
  name: "Norway",
  countryTaxType: "vat",
  parentReturnPackCode: "NO_MVA_MELDING",
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
      id: "storting_mva_2026",
      title: "Storting annual VAT decision for 2026 — 25/15/12/11.11 bands applicable from 1 January 2026 (applicability, not origin)",
      url: "https://lovdata.no/LTI/forskrift/2025-12-18-2752",
      asOf: "2026-08-01",
    },
    {
      id: "storting_mva_2025",
      title: "Storting annual VAT decision for 2025 — 25/15/12/11.11 bands applicable from 1 January 2025",
      url: "https://lovdata.no/LTI/forskrift/2024-12-13-3208",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2012",
      title: "Skatteetaten — Merverdiavgift satser for 2012: general 25%, food 15%, low 8% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2012",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2013",
      title: "Skatteetaten — Merverdiavgift satser for 2013: general 25%, food 15%, low 8% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2013",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2014",
      title: "Skatteetaten — Merverdiavgift satser for 2014: general 25%, food 15%, low 8% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2014",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2015",
      title: "Skatteetaten — Merverdiavgift satser for 2015: general 25%, food 15%, low 8% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2015",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2016",
      title: "Skatteetaten — Merverdiavgift satser for 2016: general 25%, food 15%, low 10%; notes the 14 December 2015 Storting decision raising the low rate from 8% to 10% for 2016",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2016",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2017",
      title: "Skatteetaten — Merverdiavgift satser for 2017: general 25%, food 15%, low 10% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2017",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2018",
      title: "Skatteetaten — Merverdiavgift satser for 2018: general 25%, food 15%, low 12% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2018",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2019",
      title: "Skatteetaten — Merverdiavgift satser for 2019: general 25%, food 15%, low 12% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2019",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2020",
      title: "Skatteetaten — Merverdiavgift satser for 2020: general 25%, food 15%, low 12% with the temporary 12%-to-6% cut from 1 April 2020 to 30 September 2021 stated on the same page",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2020",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2021",
      title: "Skatteetaten — Merverdiavgift satser for 2021: general 25%, food 15%, low 12% with the temporary 12%-to-6% cut from 1 April 2020 to 30 September 2021 stated on the same page",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2021",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2022",
      title: "Skatteetaten — Merverdiavgift satser for 2022: general 25%, food 15%, low 12% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2022",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2023",
      title: "Skatteetaten — Merverdiavgift satser for 2023: general 25%, food 15%, low 12% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2023",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2024",
      title: "Skatteetaten — Merverdiavgift satser for 2024: general 25%, food 15%, low 12% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2024",
      asOf: "2026-09-18",
    },
    {
      id: "skatteetaten_satshistorikk_2025",
      title: "Skatteetaten — Merverdiavgift satser for 2025: general 25%, food 15%, low 12% (year-table applicability)",
      url: "https://www.skatteetaten.no/satser/merverdiavgift/?year=2025",
      asOf: "2026-09-18",
    },
    {
      id: "saft_mva_koder",
      title: "Skatteetaten mva-meldingen — SAF-T VAT code list (mvaKodeSAFT) mapping return codes to rate bands",
      url: "https://github.com/Skatteetaten/mva-meldingen/blob/master/docs/informasjonsmodell_filer/kodelister/mvaKodeSAFT.xml",
      asOf: "2026-08-01",
    },
    {
      id: "skatteetaten_mva_melding",
      title: "Skatteetaten — Mva-melding: view, amend and file (Altinn and accounting-software submission)",
      url: "https://www.skatteetaten.no/bedrift-og-organisasjon/avgifter/mva/mva-melding/",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [NO_MVA_MELDING_2026],
  returnPackTaxCodes: {
    NO_MVA_MELDING: [
      {
        code: "NO-VAT-STD",
        name: "Norway standard VAT 25% (høy sats)",
        ratePercent: 25,
        role: "standard",
        rates: [
          { ratePercent: 25, effectiveFrom: "2012-01-01", effectiveTo: "2012-12-31", sourceId: "skatteetaten_satshistorikk_2012" },
          { ratePercent: 25, effectiveFrom: "2013-01-01", effectiveTo: "2013-12-31", sourceId: "skatteetaten_satshistorikk_2013" },
          { ratePercent: 25, effectiveFrom: "2014-01-01", effectiveTo: "2014-12-31", sourceId: "skatteetaten_satshistorikk_2014" },
          { ratePercent: 25, effectiveFrom: "2015-01-01", effectiveTo: "2015-12-31", sourceId: "skatteetaten_satshistorikk_2015" },
          { ratePercent: 25, effectiveFrom: "2016-01-01", effectiveTo: "2016-12-31", sourceId: "skatteetaten_satshistorikk_2016" },
          { ratePercent: 25, effectiveFrom: "2017-01-01", effectiveTo: "2017-12-31", sourceId: "skatteetaten_satshistorikk_2017" },
          { ratePercent: 25, effectiveFrom: "2018-01-01", effectiveTo: "2018-12-31", sourceId: "skatteetaten_satshistorikk_2018" },
          { ratePercent: 25, effectiveFrom: "2019-01-01", effectiveTo: "2019-12-31", sourceId: "skatteetaten_satshistorikk_2019" },
          { ratePercent: 25, effectiveFrom: "2020-01-01", effectiveTo: "2020-12-31", sourceId: "skatteetaten_satshistorikk_2020" },
          { ratePercent: 25, effectiveFrom: "2021-01-01", effectiveTo: "2021-12-31", sourceId: "skatteetaten_satshistorikk_2021" },
          { ratePercent: 25, effectiveFrom: "2022-01-01", effectiveTo: "2022-12-31", sourceId: "skatteetaten_satshistorikk_2022" },
          { ratePercent: 25, effectiveFrom: "2023-01-01", effectiveTo: "2023-12-31", sourceId: "skatteetaten_satshistorikk_2023" },
          { ratePercent: 25, effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31", sourceId: "skatteetaten_satshistorikk_2024" },
          { ratePercent: 25, effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31", sourceId: "skatteetaten_satshistorikk_2025" },
          { ratePercent: 25, effectiveFrom: "2026-01-01", sourceId: "storting_mva_2026" },
        ],
      },
      {
        code: "NO-VAT-FOOD",
        name: "Norway food VAT 15% (middels sats næringsmidler)",
        ratePercent: 15,
        role: "reduced",
        rates: [
          { ratePercent: 15, effectiveFrom: "2012-01-01", effectiveTo: "2012-12-31", sourceId: "skatteetaten_satshistorikk_2012" },
          { ratePercent: 15, effectiveFrom: "2013-01-01", effectiveTo: "2013-12-31", sourceId: "skatteetaten_satshistorikk_2013" },
          { ratePercent: 15, effectiveFrom: "2014-01-01", effectiveTo: "2014-12-31", sourceId: "skatteetaten_satshistorikk_2014" },
          { ratePercent: 15, effectiveFrom: "2015-01-01", effectiveTo: "2015-12-31", sourceId: "skatteetaten_satshistorikk_2015" },
          { ratePercent: 15, effectiveFrom: "2016-01-01", effectiveTo: "2016-12-31", sourceId: "skatteetaten_satshistorikk_2016" },
          { ratePercent: 15, effectiveFrom: "2017-01-01", effectiveTo: "2017-12-31", sourceId: "skatteetaten_satshistorikk_2017" },
          { ratePercent: 15, effectiveFrom: "2018-01-01", effectiveTo: "2018-12-31", sourceId: "skatteetaten_satshistorikk_2018" },
          { ratePercent: 15, effectiveFrom: "2019-01-01", effectiveTo: "2019-12-31", sourceId: "skatteetaten_satshistorikk_2019" },
          { ratePercent: 15, effectiveFrom: "2020-01-01", effectiveTo: "2020-12-31", sourceId: "skatteetaten_satshistorikk_2020" },
          { ratePercent: 15, effectiveFrom: "2021-01-01", effectiveTo: "2021-12-31", sourceId: "skatteetaten_satshistorikk_2021" },
          { ratePercent: 15, effectiveFrom: "2022-01-01", effectiveTo: "2022-12-31", sourceId: "skatteetaten_satshistorikk_2022" },
          { ratePercent: 15, effectiveFrom: "2023-01-01", effectiveTo: "2023-12-31", sourceId: "skatteetaten_satshistorikk_2023" },
          { ratePercent: 15, effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31", sourceId: "skatteetaten_satshistorikk_2024" },
          { ratePercent: 15, effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31", sourceId: "skatteetaten_satshistorikk_2025" },
          { ratePercent: 15, effectiveFrom: "2026-01-01", sourceId: "storting_mva_2026" },
        ],
      },
      {
        code: "NO-VAT-PASSENGER",
        name: "Norway passenger, accommodation and culture VAT 12% (lav sats)",
        ratePercent: 12,
        role: "reduced",
        rates: [
          { ratePercent: 8, effectiveFrom: "2012-01-01", effectiveTo: "2012-12-31", sourceId: "skatteetaten_satshistorikk_2012" },
          { ratePercent: 8, effectiveFrom: "2013-01-01", effectiveTo: "2013-12-31", sourceId: "skatteetaten_satshistorikk_2013" },
          { ratePercent: 8, effectiveFrom: "2014-01-01", effectiveTo: "2014-12-31", sourceId: "skatteetaten_satshistorikk_2014" },
          { ratePercent: 8, effectiveFrom: "2015-01-01", effectiveTo: "2015-12-31", sourceId: "skatteetaten_satshistorikk_2015" },
          { ratePercent: 10, effectiveFrom: "2016-01-01", effectiveTo: "2016-12-31", sourceId: "skatteetaten_satshistorikk_2016" },
          { ratePercent: 10, effectiveFrom: "2017-01-01", effectiveTo: "2017-12-31", sourceId: "skatteetaten_satshistorikk_2017" },
          { ratePercent: 12, effectiveFrom: "2018-01-01", effectiveTo: "2018-12-31", sourceId: "skatteetaten_satshistorikk_2018" },
          { ratePercent: 12, effectiveFrom: "2019-01-01", effectiveTo: "2019-12-31", sourceId: "skatteetaten_satshistorikk_2019" },
          { ratePercent: 12, effectiveFrom: "2020-01-01", effectiveTo: "2020-03-31", sourceId: "skatteetaten_satshistorikk_2020" },
          { ratePercent: 6, effectiveFrom: "2020-04-01", effectiveTo: "2021-09-30", sourceId: "skatteetaten_satshistorikk_2020" },
          { ratePercent: 12, effectiveFrom: "2021-10-01", effectiveTo: "2021-12-31", sourceId: "skatteetaten_satshistorikk_2021" },
          { ratePercent: 12, effectiveFrom: "2022-01-01", effectiveTo: "2022-12-31", sourceId: "skatteetaten_satshistorikk_2022" },
          { ratePercent: 12, effectiveFrom: "2023-01-01", effectiveTo: "2023-12-31", sourceId: "skatteetaten_satshistorikk_2023" },
          { ratePercent: 12, effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31", sourceId: "skatteetaten_satshistorikk_2024" },
          { ratePercent: 12, effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31", sourceId: "skatteetaten_satshistorikk_2025" },
          { ratePercent: 12, effectiveFrom: "2026-01-01", sourceId: "storting_mva_2026" },
        ],
      },
      {
        code: "NO-VAT-FISH-1111",
        name: "Norway wild marine resources VAT 11.11%",
        ratePercent: 11.11,
        rates: [
          { ratePercent: 11.11, effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31", sourceId: "storting_mva_2025" },
          { ratePercent: 11.11, effectiveFrom: "2026-01-01", sourceId: "storting_mva_2026" },
        ],
      },
    ],
  },
};
