import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const CZ_DPH_2026: TaxReturnPack = {
  code: "CZ_DPH",
  name: "Přiznání k DPH — daň z přidané hodnoty",
  country: "CZ",
  jurisdiction: { code: "CZ", name: "Czechia", country: "CZ", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "file_upload",
  governmentFormat: "certified_file",
  submissionUrl: "https://adisspr.mfcr.cz/pmd/",
  watermark: "Working copy — základní zdaňovací období je kalendářní měsíc; čtvrtletní volba (obrat do 15 mil. Kč a 2 roky od registrace) je nemodelovaná; kontrolní hlášení (DPHKH1) je samostatné povinné podání mimo tento pack; měna CZK; file through MOJE daně (EPO) as DPHDP3 XML",
  boxes: [
    { lineCode: "1", label: "Řádek 1 — tuzemská zdanitelná plnění, základní sazba 21 %: základ daně a daň", sign: 1, sequence: 10 },
    { lineCode: "2", label: "Řádek 2 — tuzemská zdanitelná plnění, snížená sazba 12 %: základ daně a daň", sign: 1, sequence: 20 },
    { lineCode: "20", label: "Řádek 20 — dodání zboží do jiného členského státu", sign: 1, sequence: 30 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all rates", sign: -1, sequence: 40, basis: "tax_collected", glMap: "sales" },
    { lineCode: "40", label: "Řádek 40 — odpočet z přijatých zdanitelných plnění, základní sazba", sign: 1, sequence: 50 },
    { lineCode: "41", label: "Řádek 41 — odpočet z přijatých zdanitelných plnění, snížená sazba", sign: 1, sequence: 60 },
    { lineCode: "46", label: "Řádek 46 — odpočet celkem (součet)", sign: 1, sequence: 70 },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all rates", sign: 1, sequence: 80, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "62", label: "Řádek 62 — daň na výstupu celkem", sign: 1, sequence: 90 },
    { lineCode: "63", label: "Řádek 63 — odpočet daně celkem", sign: 1, sequence: 100 },
    { lineCode: "64", label: "Řádek 64 — vlastní daňová povinnost (daň k úhradě)", sign: 1, sequence: 110 },
    { lineCode: "65", label: "Řádek 65 — nadměrný odpočet", sign: 1, sequence: 120 },
  ],
};

/**
 * Czechia DPH localization, post-2024 consolidation shape only.
 *
 * Named refusals: the 15% and 10% reduced bands closed 2023-12-31 (single
 * 12% band from 2024-01-01 per Government Bill 488); the pre-2013 20%
 * standard band and the pre-2024 10% book band are not transcribed — no
 * origin dates are claimed. Kontrolní hlášení (DPHKH1) is a separate
 * mandatory filing and is not modelled here.
 *
 * SOURCING: two citations are non-authority, kept as named id-specific
 * exceptions (wave5 proof). `sovos_cz_consolidation_2024` (Sovos regulatory
 * update on Government Bill 488) is the only reachable attestation of the
 * 15%+10% to 12% consolidation and the 2024-01-01 date — the consolidation
 * act (349/2023 Sb.) is not retrievable from the e-Sbírka portal from this
 * sandbox and the FS site serves its guidance through a JS application, so
 * the FS leaflet (which attests current 21%/12%/books-exempt applicability
 * only) cannot carry the date. `msft_dynamics_cz_rows` (learn.microsoft.com
 * documentation page for the Czech VAT declaration rows and DPHDP3/DPHKH1
 * formats) corroborates the return transcription; no FS-hosted equivalent
 * is reachable.
 * Neither changes any rate value; truncating to FS-attested-only would
 * delete the 2024 consolidation the pack exists to carry.
 */
export const CZECHIA_TAX_PACK: CountryTaxPackDefinition = {
  code: "CZ_INDIRECT_TAX",
  version: "2026.08.01",
  country: "CZ",
  name: "Czechia",
  countryTaxType: "vat",
  parentReturnPackCode: "CZ_DPH",
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
      id: "fs_dph_leaflet_2026",
      title: "Finanční správa — DPH leaflet: 21% basic and 12% reduced rates, books exempt with right of deduction, monthly period, quarterly election, mandatory kontrolní hlášení (applicability, no origin claimed)",
      url: "https://financnisprava.gov.cz/assets/cs/prilohy/fs-financni-sprava-cr/EtR_Dan_z_pridane_hodnoty_2026.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "sovos_cz_consolidation_2024",
      title: "Sovos — Government Bill 488: 15% and 10% replaced by single 12% from 1 January 2024; books exempt with right of deduction",
      url: "https://sovos.com/regulatory-updates/vat/czech-republic-vat-law-changes/",
      asOf: "2026-09-18",
    },
    {
      id: "msft_dynamics_cz_rows",
      title: "Microsoft Dynamics 365 — Czech VAT declaration rows 1, 2, 20, 40, 41, 46, 62–65 and DPHDP3 XML / DPHKH1 control-statement formats",
      url: "https://learn.microsoft.com/en-us/dynamics365/finance/localizations/czech-republic/emea-cze-vat-declaration-tax-declaration-model",
      asOf: "2026-09-18",
    },
    {
      id: "mojedane_portal",
      title: "MOJE daně — electronic tax portal (EPO) for DPHDP3 lodgement",
      url: "https://adisspr.mfcr.cz/pmd/",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [CZ_DPH_2026],
  returnPackTaxCodes: {
    CZ_DPH: [
      {
        code: "CZ-VAT-STD",
        name: "Czechia standard DPH",
        ratePercent: 21,
        role: "standard",
        rates: [{ ratePercent: 21, effectiveFrom: "2024-01-01", sourceId: "fs_dph_leaflet_2026" }],
      },
      {
        code: "CZ-VAT-RED12",
        name: "Czechia reduced DPH 12%",
        ratePercent: 12,
        role: "reduced",
        rates: [{ ratePercent: 12, effectiveFrom: "2024-01-01", sourceId: "sovos_cz_consolidation_2024" }],
      },
      {
        code: "CZ-VAT-ZERO",
        name: "Czechia zero-rated book supplies (exempt with right of deduction)",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2024-01-01", sourceId: "sovos_cz_consolidation_2024" }],
      },
    ],
  },
};
