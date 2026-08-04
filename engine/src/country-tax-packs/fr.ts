import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const FR_CA3_2026: TaxReturnPack = {
  code: "FR_CA3",
  name: "Déclaration de TVA 2026 (3310-CA3-SD)",
  country: "FR",
  jurisdiction: { code: "FR", name: "France", country: "FR", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "file_upload",
  governmentFormat: "certified_file",
  submissionUrl: "https://www.impots.gouv.fr/formulaire/3310-ca3-sd/tva-et-taxes-assimilees-regime-du-reel-normal-mini-reel",
  watermark: "Working copy — télédeclare through impots.gouv.fr using EFI or EDI; territorial rates and filing eligibility require filer review",
  boxes: [
    { lineCode: "A1", label: "A1 — sales and services: amount excluding VAT", sign: 1, sequence: 10 },
    { lineCode: "E1", label: "E1 — exports outside the European Union", sign: 1, sequence: 20 },
    { lineCode: "08", label: "Line 08 — transactions at the metropolitan standard rate of 20%: net base and tax due", sign: 1, sequence: 30 },
    { lineCode: "09", label: "Line 09 — transactions at the reduced rate of 5.5%: net base and tax due", sign: 1, sequence: 40 },
    { lineCode: "9B", label: "Line 9B — transactions at the reduced rate of 10%: net base and tax due", sign: 1, sequence: 50 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all rates", sign: -1, sequence: 60, basis: "tax_collected", glMap: "sales" },
    { lineCode: "16", label: "Line 16 — total gross VAT due", sign: 1, sequence: 70 },
    { lineCode: "19", label: "Line 19 — deductible VAT on capital assets", sign: 1, sequence: 80 },
    { lineCode: "20", label: "Line 20 — deductible VAT on other goods and services", sign: 1, sequence: 90 },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all rates", sign: 1, sequence: 100, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "23", label: "Line 23 — total deductible VAT", sign: 1, sequence: 110 },
    { lineCode: "25", label: "Line 25 — VAT credit", sign: 1, sequence: 120 },
    { lineCode: "TD", label: "Line TD — VAT due", sign: 1, sequence: 130 },
    { lineCode: "28", label: "Line 28 — net VAT due", sign: 1, sequence: 140 },
  ],
};

/** France VAT localization; standard-rate automation is scoped to metropolitan France. */
export const FRANCE_TAX_PACK: CountryTaxPackDefinition = {
  code: "FR_INDIRECT_TAX",
  version: "2026.08.01",
  country: "FR",
  name: "France",
  countryTaxType: "vat",
  parentReturnPackCode: "FR_CA3",
  completeness: {
    jurisdictions: "partial",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "partial",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "dgfip_standard_vat_2014",
      title: "DGFiP BOFiP — standard VAT rate of 20% from 1 January 2014",
      url: "https://bofip.impots.gouv.fr/bofip/9226-PGP.html/identifiant=BOI-TVA-LIQ-50-20140319",
      asOf: "2026-08-01",
    },
    {
      id: "dgfip_ca3_2026",
      title: "DGFiP — official 2026 form 3310-CA3-SD",
      url: "https://www.impots.gouv.fr/sites/default/files/formulaires/3310-ca3-sd/2026/3310-ca3-sd_5377.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "dgfip_ca3_notice_2026",
      title: "DGFiP — official 2026 notice for form 3310-CA3-SD",
      url: "https://www.impots.gouv.fr/sites/default/files/formulaires/3310-ca3-sd/2026/3310-ca3-sd_5426.pdf",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [FR_CA3_2026],
  returnPackTaxCodes: {
    FR_CA3: {
      code: "FR-VAT-STD",
      name: "France metropolitan standard VAT",
      ratePercent: 20,
      rates: [{ ratePercent: 20, effectiveFrom: "2014-01-01", sourceId: "dgfip_standard_vat_2014" }],
    },
  },
};
