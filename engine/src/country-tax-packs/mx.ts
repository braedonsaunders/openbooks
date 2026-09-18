import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const MX_IVA_MENSUAL_2026: TaxReturnPack = {
  code: "MX_IVA_MENSUAL",
  name: "Pago definitivo mensual del IVA 2026 (LIVA art. 5-D)",
  country: "MX",
  jurisdiction: { code: "MX", name: "Mexico — IVA territory", country: "MX", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.sat.gob.mx/declaracion/87655/presentatudeclaraciondepagos",
  watermark: "Working copy — present the pago definitivo by day 17 in the SAT Declaraciones y Pagos portal; reconcile the CFDI precarga before filing",
  boxes: [
    { lineCode: "IVA-CAUSADO", label: "IVA causado — impuesto trasladado en los actos o actividades del mes", sign: -1, sequence: 10 },
    { lineCode: "IVA-ACREDITABLE", label: "IVA acreditable — impuesto trasladado al contribuyente y pagado en el mes", sign: 1, sequence: 20 },
    { lineCode: "IVA-CARGO", label: "IVA a cargo — diferencia a pagar del mes", sign: 1, sequence: 30 },
    { lineCode: "IVA-FAVOR", label: "IVA a favor — saldo a favor del mes", sign: 1, sequence: 40 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output IVA from the ledger, all configured rates", sign: -1, sequence: 50, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input IVA from the ledger, all configured rates", sign: 1, sequence: 60, basis: "tax_paid", glMap: "purchases" },
  ],
};

/** Mexico IVA localization — pago definitivo mensual (LIVA Article 5-D, due day 17 of the following month).
 *
 * IVA ONLY. IEPS, ISR, retenciones, DIOT, and CFDI are explicitly out of scope for this pack.
 *
 * Rates are left-truncated at 2014-01-01: the DOF 11-12-2013 decree repealed LIVA Article 2
 * (the 11% border rate), so the 16% general rate has applied nationwide since that date; the
 * pre-2014 15%/11% history is refused by name here and scored `partial`, not transcribed.
 *
 * The 8% border band is a presidential decreto stimulus (a 50% credit against the Article 1
 * rate), not an LIVA rate: north via the DOF 31-12-2018 decree (in force 2019-01-01), south via
 * the DOF 30-12-2020 decree (in force 2021-01-01), each as a separate code because their start
 * dates differ. Both were extended through 2025-12-31 (December 2024 decree) and again through
 * 2026-12-31 (DOF 31-12-2025 vespertina). The band is therefore declared with an explicit
 * `effectiveTo` of 2026-12-31 — re-verify against the Diario Oficial before assuming 2027.
 * It is a rate band on the federal return, NOT a subnational jurisdiction: `jurisdictions` is
 * empty and Mexico has no state-level IVA.
 */
export const MEXICO_TAX_PACK: CountryTaxPackDefinition = {
  code: "MX_INDIRECT_TAX",
  version: "2026.08.01",
  country: "MX",
  name: "Mexico",
  countryTaxType: "vat",
  parentReturnPackCode: "MX_IVA_MENSUAL",
  completeness: {
    jurisdictions: "partial",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "liva_texto_vigente",
      title: "LIVA current consolidated text (Cámara de Diputados) — Article 1 (16%), Article 2-A (tasa 0%), Article 5-D (monthly definitiva)",
      url: "https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "dof_2013_liva_reform",
      title: "DOF 11-12-2013 LIVA reform decree itself (nota 5325371) — ARTÍCULO PRIMERO: “se derogan los artículos … 2o.; 2o.-C … de la Ley del Impuesto al Valor Agregado” (“Artículo 2o. (Se deroga)”); same decree TRANSITORIOS Primero (sibling nota 5325373): “El presente Decreto entrará en vigor el 1 de enero de 2014” — 16% nationwide applicability from that date",
      url: "https://dof.gob.mx/nota_detalle.php?codigo=5325371&fecha=11/12/2013",
      asOf: "2026-09-18",
    },
    {
      id: "decreto_frontera_norte_2018",
      title: "Decreto de estímulos fiscales región fronteriza norte (DOF 31-12-2018, SAT copy) — 50% IVA credit, effective rate 8%",
      url: "https://www.sat.gob.mx/minisitio/EstimulosFiscalesFronteraNorteSur/region_fronteriza_norte_isr/documentos/Decreto_de_estimulos_fiscales_region_fronteriza_norte.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "decreto_fronteras_prorroga_2024",
      title: "DOF 24-12-2024 vespertina (nota 5746128) — ARTÍCULO SEGUNDO reforms the north decree transitory: “El presente Decreto entrará en vigor el 1 de enero de 2019 y estará vigente hasta el 31 de diciembre de 2025”; ARTÍCULO TERCERO reforms the south decree transitory: “entrará en vigor el 1 de enero de 2021 y estará vigente hasta el 31 de diciembre de 2025”",
      url: "https://dof.gob.mx/nota_detalle.php?codigo=5746128&fecha=24/12/2024",
      asOf: "2026-09-18",
    },
    {
      id: "decreto_fronteras_prorroga_2026",
      title: "DOF 31-12-2025 (vespertina) — Decreto por el que se modifica los diversos de estímulos fiscales región fronteriza norte y región fronteriza sur; extends both stimuli through 31-12-2026 (verified against the DOF nota_detalle, not a consultancy summary)",
      url: "https://dof.gob.mx/nota_detalle.php?codigo=5777697&fecha=31/12/2025",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [MX_IVA_MENSUAL_2026],
  returnPackTaxCodes: {
    MX_IVA_MENSUAL: [
      {
        code: "MX-VAT-STD",
        name: "Mexico IVA general rate",
        ratePercent: 16,
        role: "standard",
        rates: [{ ratePercent: 16, effectiveFrom: "2014-01-01", sourceId: "dof_2013_liva_reform" }],
      },
      {
        code: "MX-VAT-NORTH-8",
        name: "Northern border-region stimulus rate (2018 decree)",
        ratePercent: 8,
        role: "reduced",
        rates: [
          { ratePercent: 8, effectiveFrom: "2019-01-01", effectiveTo: "2025-12-31", sourceId: "decreto_fronteras_prorroga_2024" },
          { ratePercent: 8, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", sourceId: "decreto_fronteras_prorroga_2026" },
        ],
      },
      {
        code: "MX-VAT-SOUTH-8",
        name: "Southern border-region stimulus rate (2020 decree)",
        ratePercent: 8,
        role: "reduced",
        rates: [
          { ratePercent: 8, effectiveFrom: "2021-01-01", effectiveTo: "2025-12-31", sourceId: "decreto_fronteras_prorroga_2024" },
          { ratePercent: 8, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", sourceId: "decreto_fronteras_prorroga_2026" },
        ],
      },
      {
        code: "MX-VAT-ZERO",
        name: "Mexico IVA tasa 0% (LIVA Article 2-A)",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2014-01-01", sourceId: "liva_texto_vigente" }],
      },
    ],
  },
};
