import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const HU_AFA_65_2026: TaxReturnPack = {
  code: "HU_AFA_65",
  name: "ÁFA bevallás 65 — általános forgalmi adó bevallás 2026",
  country: "HU",
  jurisdiction: { code: "HU", name: "Hungary", country: "HU", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "file_upload",
  governmentFormat: "certified_file",
  submissionUrl: "https://nav.gov.hu/pfile/file?path=/nyomtatvanyok/letoltesek/nyomtatvanykitolto_programok/nyomtatvanykitolto_programok_nav/2465/2465-kitoltesi-utmutato",
  watermark: "Working copy — file through NAV ÁNYK / eÁFA; quarterly and annual periods are threshold elections the pack does not model",
  boxes: [
    { lineCode: "05", label: "5. sor — belföldi teljesítési helyű 5%-os értékesítés adóalapja és adója", sign: 1, sequence: 10 },
    { lineCode: "06", label: "6. sor — belföldi teljesítési helyű 18%-os értékesítés adóalapja és adója", sign: 1, sequence: 20 },
    { lineCode: "07", label: "7. sor — 27%-os kulcs alá tartozó értékesítés adóalapja és adója", sign: 1, sequence: 30 },
    { lineCode: "110", label: "110. sor — 0%-os kulcs alá tartozó belföldi értékesítés ellenértéke", sign: 1, sequence: 40 },
    { lineCode: "36", label: "36. sor — összes fizetendő adó (01–35. és 110. sorok összesenje)", sign: 1, sequence: 50 },
    { lineCode: "64", label: "64. sor — 5%-os mértékű előzetesen felszámított adó és adóalapja", sign: 1, sequence: 60 },
    { lineCode: "65", label: "65. sor — 18%-os mértékű előzetesen felszámított adó és adóalapja", sign: 1, sequence: 70 },
    { lineCode: "66", label: "66. sor — 27%-os mértékű előzetesen felszámított adó és adóalapja", sign: 1, sequence: 80 },
    { lineCode: "111", label: "111. sor — 0%-os mértékű előzetesen felszámított adó alapja", sign: 1, sequence: 90 },
    { lineCode: "76", label: "76. sor — összes levonható előzetesen felszámított adó", sign: 1, sequence: 100 },
    { lineCode: "83", label: "83. sor — elszámolandó adó (36. sor − 76. sor − 82. sor)", sign: 1, sequence: 110 },
    { lineCode: "84", label: "84. sor — befizetendő általános forgalmi adó", sign: 1, sequence: 120 },
    { lineCode: "85", label: "85. sor — visszaigényelhető általános forgalmi adó", sign: 1, sequence: 130 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 140, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 150, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Hungary ÁFA localization. ÁFA is national: no subnational indirect tax.
 * Monthly filing is the default; quarterly and annual periods are threshold
 * elections under Art. 2. melléklet and are not modelled. Amounts are in HUF;
 * the pack contract carries no currency field. Online Számla real-time invoice
 * reporting and the 65M partner summary are named out of scope and undeclared.
 */
export const HUNGARY_TAX_PACK: CountryTaxPackDefinition = {
  code: "HU_INDIRECT_TAX",
  version: "2026.08.01",
  country: "HU",
  name: "Hungary",
  countryTaxType: "vat",
  parentReturnPackCode: "HU_AFA_65",
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
      id: "nav_afa65_guide",
      title: "NAV — 2465 ÁFA bevallás kitöltési útmutató (sorok, ÁNYK kitöltő-ellenőrző, eÁFA/M2M)",
      url: "https://nav.gov.hu/pfile/file?path=/nyomtatvanyok/letoltesek/nyomtatvanykitolto_programok/nyomtatvanykitolto_programok_nav/2465/2465-kitoltesi-utmutato",
      asOf: "2026-08-01",
    },
    {
      id: "nav_vat_rates_current",
      title: "NAV — VAT liabilities of foreign marketers in Hungary (applicability only: 27% general and 18%/5%/0% bands confirmed in force; reduced/zero band origins predate 2012, left-truncated, no origin claimed)",
      url: "https://nav.gov.hu/pfile/file?path=/en/taxation/taxinfo/vat-liabilities-of-foreign-marketers-in-hungary",
      asOf: "2026-08-01",
    },
    {
      id: "afa_rate_change_2012",
      title: "Magyar Közlöny 2011/140 (2011-11-29) — 2011. évi CLVI. tv. 118. §: “Az Áfa tv. 82. § (1) bekezdése helyébe a következő rendelkezés lép: '(1) Az adó mértéke az adó alapjának 27 százaléka.'”; new Áfa tv. 275. § (2) (CLVI 130. §): the rate provisions apply first where the §84 chargeable-event date “2012. január 1. napjára esik vagy azt követi”",
      url: "https://www.magyarkozlony.hu/dokumentumok/0208418ecf1c0f06c26d14cc335968b877540082/megtekintes",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [HU_AFA_65_2026],
  returnPackTaxCodes: {
    HU_AFA_65: [
      {
        code: "HU-VAT-STD",
        name: "Hungary standard ÁFA",
        ratePercent: 27,
        role: "standard",
        rates: [{ ratePercent: 27, effectiveFrom: "2012-01-01", sourceId: "afa_rate_change_2012" }],
      },
      {
        code: "HU-VAT-RED18",
        name: "Hungary reduced ÁFA 18%",
        ratePercent: 18,
        role: "reduced",
        rates: [{ ratePercent: 18, effectiveFrom: "2012-01-01", sourceId: "nav_vat_rates_current" }],
      },
      {
        code: "HU-VAT-RED5",
        name: "Hungary reduced ÁFA 5%",
        ratePercent: 5,
        role: "reduced",
        rates: [{ ratePercent: 5, effectiveFrom: "2012-01-01", sourceId: "nav_vat_rates_current" }],
      },
      {
        code: "HU-VAT-ZERO",
        name: "Hungary zero-rate ÁFA 0%",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2012-01-01", sourceId: "nav_vat_rates_current" }],
      },
    ],
  },
};
