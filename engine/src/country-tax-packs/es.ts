import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const ES_MODELO_303_2026: TaxReturnPack = {
  code: "ES_MODELO303",
  name: "Modelo 303 — IVA Autoliquidación 2026",
  country: "ES",
  jurisdiction: { code: "ES", name: "Spain — IVA territory", country: "ES", level: "country", taxType: "vat" },
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://sede.agenciatributaria.gob.es/Sede/procedimientoini/G414.shtml",
  watermark: "Working copy — review territorial and special-regime treatment, then file through the AEAT electronic office",
  boxes: [
    { lineCode: "01", label: "Casilla 01 — taxable base for transactions at 4%", sign: 1, sequence: 10 },
    { lineCode: "02", label: "Casilla 02 — rate (4%)", sign: 1, sequence: 20 },
    { lineCode: "03", label: "Casilla 03 — VAT accrued at 4%", sign: -1, sequence: 30 },
    { lineCode: "04", label: "Casilla 04 — taxable base for transactions at 10%", sign: 1, sequence: 40 },
    { lineCode: "05", label: "Casilla 05 — rate (10%)", sign: 1, sequence: 50 },
    { lineCode: "06", label: "Casilla 06 — VAT accrued at 10%", sign: -1, sequence: 60 },
    { lineCode: "07", label: "Casilla 07 — taxable base for transactions at 21%", sign: 1, sequence: 70 },
    { lineCode: "08", label: "Casilla 08 — rate (21%)", sign: 1, sequence: 80 },
    { lineCode: "09", label: "Casilla 09 — VAT accrued at 21%", sign: -1, sequence: 90 },
    { lineCode: "27", label: "Casilla 27 — total VAT accrued", sign: -1, sequence: 100 },
    { lineCode: "28", label: "Casilla 28 — deductible domestic current-goods/services base", sign: 1, sequence: 110 },
    { lineCode: "29", label: "Casilla 29 — deductible domestic current-goods/services VAT", sign: 1, sequence: 120 },
    { lineCode: "45", label: "Casilla 45 — total deductible VAT", sign: 1, sequence: 130 },
    { lineCode: "46", label: "Casilla 46 — general-regime result", sign: 1, sequence: 140 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 150, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 160, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Spain IVA localization. The Modelo 303 régimen-general block carries all
 * three output bands — 4% superreducido on casillas 01/02/03, 10% reducido
 * on 04/05/06, 21% general on 07/08/09 — per the AEAT 2026 instructions
 * ("En las casillas 01, 02 y 03 ... al tipo del 4% ... 04, 05 y 06 ...
 * al tipo del 10% ... 07, 08 y 09 ... al tipo del 21%"), with casilla 27
 * totalling the accrued cuotas. Canary Islands, Ceuta, Melilla, and special
 * regimes remain explicitly out of scope.
 */
export const SPAIN_TAX_PACK: CountryTaxPackDefinition = {
  code: "ES_INDIRECT_TAX",
  version: "2026.08.01",
  country: "ES",
  name: "Spain",
  countryTaxType: "vat",
  parentReturnPackCode: "ES_MODELO303",
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
      id: "aeat_standard_rate_21",
      title: "AEAT — IVA general regime rates",
      url: "https://sede.agenciatributaria.gob.es/Sede/iva/regimenes-tributacion-iva/regimen-general.html",
      asOf: "2026-08-01",
    },
    {
      id: "aeat_2012_standard_rate_change",
      title: "AEAT — 2012 collection report documenting the 18% to 21% change on 1 September 2012",
      url: "https://sede.agenciatributaria.gob.es/static_files/AEAT/Estudios/Estadisticas/Informes_Estadisticos/Informes_mensuales_recaudacion_tributaria/2013/IMR_13_02.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "aeat_modelo303_2026",
      title: "AEAT — Modelo 303 instructions for 2026",
      url: "https://sede.agenciatributaria.gob.es/Sede/todas-gestiones/impuestos-tasas/iva/modelo-303-iva-autoliquidacion_/instrucciones-2026.html",
      asOf: "2026-08-01",
    },
    {
      id: "aeat_reduced_rates_applicability",
      title: "AEAT — IVA reducido (10%) and superreducido (4%) applicability, left-truncated: the current rates page states no origin date",
      url: "https://sede.agenciatributaria.gob.es/Sede/iva/regimenes-tributacion-iva/regimen-general.html",
      asOf: "2026-03-26",
    },
  ],
  jurisdictions: [],
  returnPacks: [ES_MODELO_303_2026],
  returnPackTaxCodes: {
    ES_MODELO303: [
      {
        code: "ES-VAT-STD",
        name: "Spain IVA-territory standard VAT",
        ratePercent: 21,
        rates: [{ ratePercent: 21, effectiveFrom: "2012-09-01", sourceId: "aeat_2012_standard_rate_change" }],
      },
      {
        code: "ES-VAT-RED",
        name: "Spain IVA-territory reducido VAT",
        ratePercent: 10,
        role: "reduced",
        rates: [{ ratePercent: 10, effectiveFrom: "2026-03-26", sourceId: "aeat_reduced_rates_applicability" }],
        truncatedScheduleReason:
          "The AEAT rates page states current 10% applicability with no origin date, so the schedule opens at verification, not at the band's origin.",
      },
      {
        code: "ES-VAT-SUPERRED",
        name: "Spain IVA-territory superreducido VAT",
        ratePercent: 4,
        role: "reduced",
        rates: [{ ratePercent: 4, effectiveFrom: "2026-03-26", sourceId: "aeat_reduced_rates_applicability" }],
        truncatedScheduleReason:
          "The AEAT rates page states current 4% applicability with no origin date, so the schedule opens at verification, not at the band's origin.",
      },
    ],
  },
};
