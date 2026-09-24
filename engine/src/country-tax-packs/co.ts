import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const CO_F300_IVA: TaxReturnPack = {
  code: "CO_F300",
  name: "Formulario 300 — Declaración de IVA",
  country: "CO",
  jurisdiction: { code: "CO", name: "Colombia", country: "CO", level: "country", taxType: "vat" },
  defaultFrequency: "bimonthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://muisca.dian.gov.co/",
  watermark: "Working copy — confirm the filing period on MUISCA, then file through the DIAN electronic service",
  boxes: [
    { lineCode: "27", label: "Renglón 27 — ingresos por operaciones gravadas al 5%", sign: 1, sequence: 10 },
    { lineCode: "28", label: "Renglón 28 — ingresos por operaciones gravadas a la tarifa general", sign: 1, sequence: 20 },
    { lineCode: "35", label: "Renglón 35 — ingresos por operaciones exentas (Arts. 477, 478 y 481 del E.T.)", sign: 1, sequence: 30 },
    { lineCode: "57", label: "Renglón 57 — impuesto generado a la tarifa del 5%", sign: -1, sequence: 40 },
    { lineCode: "58", label: "Renglón 58 — impuesto generado a la tarifa general", sign: -1, sequence: 50 },
    { lineCode: "65", label: "Renglón 65 — total impuesto generado por operaciones gravadas", sign: -1, sequence: 60 },
    { lineCode: "75", label: "Renglón 75 — total impuesto pagado o facturado", sign: 1, sequence: 70 },
    { lineCode: "79", label: "Renglón 79 — total impuestos descontables", sign: 1, sequence: 80 },
    { lineCode: "80", label: "Renglón 80 — saldo a pagar por el período fiscal", sign: 1, sequence: 90 },
    { lineCode: "81", label: "Renglón 81 — saldo a favor del período fiscal", sign: 1, sequence: 100 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 110, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 120, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Colombia IVA localization. Currency is COP; the pack carries no currency
 * field. IVA is national, so jurisdictions is empty — ICA (industria y
 * comercio) is a municipal tax and a different tax entirely, and is not
 * modeled.
 *
 * Filing is electronic through the DIAN MUISCA service; the default period is
 * bimonthly, with cuatrimestral filing for smaller taxpayers left as an
 * unmodelled election (both period tables are printed on the Form 300
 * instructivo itself).
 *
 * Exentos vs excluidos is the distinction to get right: bienes exentos
 * (E.T. arts. 477, 478, 481) are taxed at 0% WITH a right to refund, so they
 * are a zero band on this pack; bienes excluidos (E.T. arts. 424, 426, 427,
 * 476) are outside VAT entirely and get no code. The recurring "días sin
 * IVA" are temporary exemptions, not a rate band, and are out of scope.
 *
 * Rate histories are left-truncated to 2017-01-01. The 19% general rate is a
 * true origin (Ley 1819 art. 184, effective año gravable 2017); the 5% band
 * (restated by Ley 1819 art. 185) and the 0% exentos band are applicability
 * from the same date — the pre-2017 origin under earlier reforms was not
 * fetched from an authority. secretariasenado.gov.co returned 000 from this
 * sandbox (TLS interception, not an origin refusal), so Ley 1819 is cited via
 * the official SUIN compilation instead.
 */
export const COLOMBIA_TAX_PACK: CountryTaxPackDefinition = {
  code: "CO_INDIRECT_TAX",
  version: "2026.08.01",
  country: "CO",
  name: "Colombia",
  countryTaxType: "vat",
  parentReturnPackCode: "CO_F300",
  completeness: {
    jurisdictions: "not_applicable",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "not_applicable",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "dian_form300_2018",
      title: "DIAN — Formulario 300 (2018) with filing instructivo: renglones 27, 28, 35, 57, 58, 65, 75, 79–81, bimestral/cuatrimestral period codes, exentas vs excluidas articles",
      url: "https://www.dian.gov.co/atencionciudadano/formulariosinstructivos/Formularios/2018/Formulario_300_2018.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "suin_ley1819_art184_19pct",
      title: "SUIN — Ley 1819 de 2016, artículo 184: tarifa general del impuesto sobre las ventas del 19%, a partir del año gravable 2017 (origin of the 19% rate)",
      url: "https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=79140",
      asOf: "2026-09-18",
    },
    {
      id: "suin_ley1819_art185_5pct_applicability",
      title: "SUIN — Ley 1819 de 2016, artículo 185 restating E.T. art. 468-1 goods at 5%: applicability, not origin (pre-2017 history not fetched)",
      url: "https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=79140",
      asOf: "2026-09-18",
    },
    {
      id: "dian_form300_exentos_applicability",
      title: "DIAN — Formulario 300 instructivo, renglón 35 (exentas, E.T. arts. 477, 478, 481): 0% band applicability, not origin",
      url: "https://www.dian.gov.co/atencionciudadano/formulariosinstructivos/Formularios/2018/Formulario_300_2018.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "dian_iva_periods_muisca",
      title: "DIAN — IVA hub: bimestral, cuatrimestral and annual periods; MUISCA electronic filing service",
      url: "https://muisca.dian.gov.co/",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [CO_F300_IVA],
  returnPackTaxCodes: {
    CO_F300: [
      {
        code: "CO-VAT-STD",
        name: "Colombia IVA general rate 19%",
        ratePercent: 19,
        role: "standard",
        rates: [{ ratePercent: 19, effectiveFrom: "2017-01-01", sourceId: "suin_ley1819_art184_19pct" }],
        // Renglones 28/58 name the "tarifa general" in words, not numbers.
        returnBoxes: ["28", "58"],
      },
      {
        code: "CO-VAT-RED5",
        name: "Colombia IVA differential rate 5%",
        ratePercent: 5,
        role: "reduced",
        rates: [{ ratePercent: 5, effectiveFrom: "2017-01-01", sourceId: "suin_ley1819_art185_5pct_applicability" }],
      },
      {
        code: "CO-VAT-ZERO",
        name: "Colombia IVA bienes exentos 0% with refund right",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2017-01-01", sourceId: "dian_form300_exentos_applicability" }],
        // Renglón 35 carries the exentas (E.T. arts. 477, 478, 481), the
        // 0%-with-refund band — "exentas" names it in words, not numbers.
        returnBoxes: ["35"],
      },
    ],
  },
};
