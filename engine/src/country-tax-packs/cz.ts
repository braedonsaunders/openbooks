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
  watermark: "Working copy — základní zdaňovací období je kalendářní měsíc; čtvrtletní volba (obrat do 15 mil. Kč a 2 roky od registrace) je nemodelovaná; kontrolní hlášení je samostatné povinné podání mimo tento pack; měna CZK; file through MOJE daně (EPO)",
  boxes: [
    { lineCode: "1", label: "Řádek 1 — dodání zboží nebo poskytnutí služby s místem plnění v tuzemsku, základní sazba: základ daně a daň", sign: 1, sequence: 10 },
    { lineCode: "2", label: "Řádek 2 — dodání zboží nebo poskytnutí služby s místem plnění v tuzemsku, snížená sazba: základ daně a daň", sign: 1, sequence: 20 },
    { lineCode: "20", label: "Řádek 20 — dodání zboží do jiného členského státu (§ 64)", sign: 1, sequence: 30 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all rates", sign: -1, sequence: 40, basis: "tax_collected", glMap: "sales" },
    { lineCode: "40", label: "Řádek 40 — odpočet z přijatých zdanitelných plnění od plátců, základní sazba", sign: 1, sequence: 50 },
    { lineCode: "41", label: "Řádek 41 — odpočet z přijatých zdanitelných plnění od plátců, snížená sazba", sign: 1, sequence: 60 },
    { lineCode: "46", label: "Řádek 46 — odpočet daně celkem (40 + 41 + 42 + 43 + 44 + 45)", sign: 1, sequence: 70 },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all rates", sign: 1, sequence: 80, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "62", label: "Řádek 62 — daň na výstupu (součet 1 až 13 – 61 + daň podle § 108 jinde neuvedená)", sign: 1, sequence: 90 },
    { lineCode: "63", label: "Řádek 63 — odpočet daně (46 V plné výši + 52 Odpočet + 53 Změna odpočtu + 60)", sign: 1, sequence: 100 },
    { lineCode: "64", label: "Řádek 64 — vlastní daň (62 – 63)", sign: 1, sequence: 110 },
    { lineCode: "65", label: "Řádek 65 — nadměrný odpočet (63 – 62)", sign: 1, sequence: 120 },
  ],
};

/**
 * Czechia DPH localization, post-2024 consolidation shape only.
 *
 * Every row number above is printed on the authority's own return form
 * (tiskopis 25 5401, vzor 26); the box labels follow that form's wording.
 * The 12% single reduced band, the unchanged 21% standard band, and the
 * book exemption with right of deduction (§ 71i) are attested by the tax
 * authority's own rate-change notice, which names the amending act
 * (zákon č. 349/2023 Sb.) and the 2024-01-01 effect date.
 *
 * Named refusals:
 * - The 21% band runs back to 2023-06-06 as a single open row: the
 *   Financial Administration's Easy-to-read leaflet of that date states the
 *   three-rate regime ("Základní sazba DPH je 21 % ... První snížená sazba
 *   DPH je 15 % ... Druhá snížená sazba je 10 % ..."), and the 2024 GFR
 *   notice corroborates 21% unchanged across the 15%/10%-to-12%
 *   consolidation — a continuing-authority collapse, so no 2024 boundary
 *   row. For the 12% band and the book exemption the notice does attest
 *   genuine origin on 2024-01-01 (the 15% and 10% bands were abolished,
 *   § 71i introduced). Pre-June-2023 history (the pre-2013 20% standard
 *   band, the closed 15%/10% bands, pre-2024 book taxation) is not
 *   transcribed: no older FS leaflet was found (guessed year URLs return
 *   the site's error page).
 * - The electronic-filing format codes (DPHDP3 for the return, DPHKH1 for
 *   the control statement) are refused: the only fetchable documents naming
 *   them are another vendor's ERP documentation, which is never a source
 *   here. The pack claims filing through MOJE daně (EPO) only.
 * - The amending act's own text was not machine-read: the official
 *   Sbírka publication page is a script-rendered application whose content
 *   is not retrievable with a plain document request, so the act is attested
 *   through the authority notice citing it, not quoted directly.
 * - www.daneelektronicky.cz returned no answer from this sandbox (000 —
 *   this sandbox's vantage only, not a statement about the host).
 * - Kontrolní hlášení is a separate mandatory filing and is not modelled
 *   here; the quarterly election is unmodelled (see watermark).
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
      id: "fs_dph_form_5401_26",
      title: "Finanční správa — Tiskopis 25 5401 vzor 26, Přiznání k dani z přidané hodnoty: řádky 1, 2, 20, 40, 41, 46, 62–65",
      url: "https://financnisprava.gov.cz/assets/tiskopisy/5401_26.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "gfr_rate_change_2024",
      title: "Generální finanční ředitelství — Informace ke změnám sazeb DPH od 1. 1. 2024: 21% unchanged, single 12% replacing 15%/10% per zákon č. 349/2023 Sb., books § 71i exempt with deduction (origin for 12%/books, applicability for 21%)",
      url: "https://financnisprava.gov.cz/assets/cs/prilohy/d-seznam-dani/Informace_GFR_ke_zmenam_sazeb_DPH_od_1_1_2024.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "fs_dph_leaflet_2023",
      title: "Finanční správa — DPH Easy-to-read leaflet 6.6.2023: basic rate 21%, first reduced 15%, second reduced 10% (three-rate regime applicability)",
      url: "https://financnisprava.gov.cz/assets/cs/prilohy/fs-financni-sprava-cr/EtR_DPH_20230606.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "fs_dph_leaflet_2026",
      title: "Finanční správa — DPH leaflet: 21% basic and 12% reduced rates, books exempt with right of deduction, monthly period, quarterly election, mandatory kontrolní hlášení, EPO registration (applicability, no origin claimed)",
      url: "https://financnisprava.gov.cz/assets/cs/prilohy/fs-financni-sprava-cr/EtR_Dan_z_pridane_hodnoty_2026.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "mojedane_portal",
      title: "MOJE daně — electronic tax portal (EPO) for DPH lodgement",
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
        rates: [{ ratePercent: 21, effectiveFrom: "2023-06-06", sourceId: "fs_dph_leaflet_2023" }],
      },
      {
        code: "CZ-VAT-RED12",
        name: "Czechia reduced DPH 12%",
        ratePercent: 12,
        role: "reduced",
        rates: [{ ratePercent: 12, effectiveFrom: "2024-01-01", sourceId: "gfr_rate_change_2024" }],
      },
      {
        code: "CZ-VAT-ZERO",
        name: "Czechia zero-rated book supplies (exempt with right of deduction)",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2024-01-01", sourceId: "gfr_rate_change_2024" }],
      },
    ],
  },
};
