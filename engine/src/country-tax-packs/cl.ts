import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const CL_F29_2026: TaxReturnPack = {
  code: "CL_F29",
  name: "Formulario 29 — Declaración Mensual y Pago Simultáneo de Impuestos (IVA)",
  country: "CL",
  jurisdiction: { code: "CL", name: "Chile", country: "CL", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.sii.cl/servicios_online/1042-.html",
  watermark:
    "Working copy — F29 is a combined monthly return: PPM and income-tax withholding lines are out of scope here; Zona Franca and impuesto-adicional regimes need filer review; file through SII Servicios online",
  boxes: [
    { lineCode: "502", label: "Línea 4 — Facturas emitidas: débito fiscal (código 502)", sign: 1, sequence: 10 },
    { lineCode: "111", label: "Línea 5 — Boletas: débito fiscal (código 111)", sign: 1, sequence: 20 },
    { lineCode: "513", label: "Línea 6 — Notas de débito emitidas (código 513)", sign: 1, sequence: 30 },
    { lineCode: "510", label: "Línea 7 — Notas de crédito emitidas por facturas: resta al débito (código 510)", sign: -1, sequence: 40 },
    { lineCode: "709", label: "Línea 8 — Notas de crédito por vales de máquinas autorizadas: resta al débito (código 709)", sign: -1, sequence: 50 },
    { lineCode: "517", label: "Línea 9 — Facturas de compra con retención parcial, contribuyentes retenidos (código 517)", sign: 1, sequence: 60 },
    { lineCode: "501", label: "Línea 10 — Liquidación factura (código 501)", sign: 1, sequence: 70 },
    { lineCode: "154", label: "Línea 11 — Adiciones al débito fiscal por devoluciones excesivas Art. 27 bis (código 154)", sign: 1, sequence: 80 },
    { lineCode: "518", label: "Línea 12 — Restitución adicional por operaciones exentas Art. 27 bis (código 518)", sign: 1, sequence: 90 },
    { lineCode: "538", label: "Línea 13 — Total débitos (código 538)", sign: 1, sequence: 100 },
    { lineCode: "520", label: "Línea 18 — Facturas recibidas del giro y facturas de compra emitidas: crédito (código 520)", sign: 1, sequence: 110 },
    { lineCode: "525", label: "Línea 19 — Facturas de activo fijo: crédito (código 525)", sign: 1, sequence: 120 },
    { lineCode: "528", label: "Línea 20 — Notas de crédito recibidas: resta al crédito (código 528)", sign: -1, sequence: 130 },
    { lineCode: "532", label: "Línea 21 — Notas de débito recibidas (código 532)", sign: 1, sequence: 140 },
    { lineCode: "535", label: "Línea 22 — Formulario de pago de importaciones del giro (código 535)", sign: 1, sequence: 150 },
    { lineCode: "553", label: "Línea 23 — Formulario de pago de importaciones de activo fijo (código 553)", sign: 1, sequence: 160 },
    { lineCode: "504", label: "Línea 24 — Remanente de crédito fiscal del mes anterior (código 504)", sign: 1, sequence: 170 },
    { lineCode: "593", label: "Línea 25 — Devolución solicitud Art. 36 a exportadores: resta al crédito (código 593)", sign: -1, sequence: 180 },
    { lineCode: "594", label: "Línea 26 — Devolución solicitud Art. 27 bis por activo fijo: resta al crédito (código 594)", sign: -1, sequence: 190 },
    { lineCode: "592", label: "Línea 27 — Certificado imputación Art. 27 bis por activo fijo (código 592)", sign: -1, sequence: 200 },
    { lineCode: "539", label: "Línea 28 — Devolución solicitud Art. 3° por cambio de sujeto (código 539)", sign: -1, sequence: 210 },
    { lineCode: "164", label: "Línea 29 — Monto reintegrado por devolución indebida de crédito fiscal D.S. 348, exportadores (código 164)", sign: 1, sequence: 220 },
    { lineCode: "127", label: "Línea 30 — Recuperación impuesto específico al petróleo diésel (código 127)", sign: 1, sequence: 230 },
    { lineCode: "544", label: "Línea 31 — Recuperación impuesto específico diésel de transportistas de carga (código 544)", sign: 1, sequence: 240 },
    { lineCode: "523", label: "Línea 32 — Crédito Art. 11 Ley 18.211 de zona franca de extensión (código 523)", sign: 1, sequence: 250 },
    { lineCode: "537", label: "Línea 33 — Total créditos (código 537)", sign: 1, sequence: 260 },
    { lineCode: "77", label: "Línea 34 — Remanente de crédito fiscal para el período siguiente (código 77)", sign: 1, sequence: 270 },
    { lineCode: "89", label: "Línea 34 — IVA determinado: total débitos menos total créditos (código 89)", sign: 1, sequence: 280, formula: "538 - 537" },
    { lineCode: "91", label: "Línea 98 — Total a pagar en plazo legal (código 91)", sign: 1, sequence: 290 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output IVA from the ledger at 19%, all documents", sign: -1, sequence: 300, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input IVA from the ledger at 19%, all documents", sign: 1, sequence: 310, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Chile IVA localization. Single national 19% rate since 1 October 2003
 * (Ley 19.888 art. 1, DL 825 art. 14); earlier 18% history is left-truncated,
 * not transcribed. No reduced rate exists. IVA is national: the Zona Franca
 * (Iquique / Punta Arenas) regimes and the impuestos adicionales on alcohol
 * and luxury goods are separate regimes, named here as out of scope. F29 also
 * carries PPM and income-tax withholding lines, which this pack does not
 * declare. Currency CLP.
 */
export const CHILE_TAX_PACK: CountryTaxPackDefinition = {
  code: "CL_INDIRECT_TAX",
  version: "2026.08.01",
  country: "CL",
  name: "Chile",
  countryTaxType: "vat",
  parentReturnPackCode: "CL_F29",
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
      id: "sii_dl825_art14_19pct",
      title: "SII — DL 825 comparado: Art. 14 general IVA rate 19%, current-law applicability (earlier history left-truncated)",
      url: "https://www.sii.cl/portales/reforma_tributaria/c_iva_con_ley_simplificacion.pdf",
      asOf: "2026-09-17",
    },
    {
      id: "contraloria_19888_oct2003",
      title: "Contraloría Dictamen 25.883/2004 — Ley 19.888 art. 1 replaces the DL 825 art. 14 rate with 19% from 1 October 2003",
      url: "https://www.contraloria.cl/buscadorpdf/dictamenes/025883N04/pdf",
      asOf: "2026-09-17",
    },
    {
      id: "sii_f29_form",
      title: "SII — Formulario 29 anverso: IVA débitos/ventas and créditos/compras códigos",
      url: "https://www.sii.cl/formularios/anverso_f29.pdf",
      asOf: "2026-09-17",
    },
    {
      id: "sii_f29_reverso",
      title: "SII — Formulario 29 reverso: special-regime and additional-tax lines named out of scope",
      url: "https://www.sii.cl/documentos/resoluciones/2005/reso151_anexo2_reverso_f29.pdf",
      asOf: "2026-09-17",
    },
    {
      id: "sii_f29_filing",
      title: "SII Servicios online — Declaración mensual (F29) gateway",
      url: "https://www.sii.cl/servicios_online/1042-.html",
      asOf: "2026-09-17",
    },
  ],
  jurisdictions: [],
  returnPacks: [CL_F29_2026],
  returnPackTaxCodes: {
    CL_F29: [
      {
        code: "CL-VAT-STD",
        name: "Chile national standard IVA",
        ratePercent: 19,
        role: "standard",
        rates: [{ ratePercent: 19, effectiveFrom: "2003-10-01", sourceId: "contraloria_19888_oct2003" }],
      },
    ],
  },
};
