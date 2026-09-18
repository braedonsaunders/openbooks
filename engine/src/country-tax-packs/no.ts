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
 * Named refusals: the full pre-2026 rate history is not transcribed (each band
 * carries the contiguous tail sourced to the 2026 annual decision, titled as
 * applicability); the temporary 12%-to-6% cut of 2020–2021 is refused because
 * both endpoints could not be sourced from the agency; the 15% band also
 * covers water/sewage per the 2026 decision but no separate code is declared
 * for it — code 31 carries the whole middels band.
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
        rates: [{ ratePercent: 25, effectiveFrom: "2026-01-01", sourceId: "storting_mva_2026" }],
      },
      {
        code: "NO-VAT-FOOD",
        name: "Norway food VAT 15% (middels sats næringsmidler)",
        ratePercent: 15,
        role: "reduced",
        rates: [{ ratePercent: 15, effectiveFrom: "2026-01-01", sourceId: "storting_mva_2026" }],
      },
      {
        code: "NO-VAT-PASSENGER",
        name: "Norway passenger, accommodation and culture VAT 12% (lav sats)",
        ratePercent: 12,
        role: "reduced",
        rates: [{ ratePercent: 12, effectiveFrom: "2026-01-01", sourceId: "storting_mva_2026" }],
      },
      {
        code: "NO-VAT-FISH-1111",
        name: "Norway wild marine resources VAT 11.11%",
        ratePercent: 11.11,
        rates: [{ ratePercent: 11.11, effectiveFrom: "2026-01-01", sourceId: "storting_mva_2026" }],
      },
    ],
  },
};
