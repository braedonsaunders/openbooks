import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const AR_F2002_2026: TaxReturnPack = {
  code: "AR_F2002",
  name: "Formulario 2002 — IVA por Actividad",
  country: "AR",
  jurisdiction: { code: "AR", name: "Argentina — IVA national territory", country: "AR", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.arca.gob.ar/iva/responsables-inscriptos/",
  watermark: "Working copy — confirm actividad registration and alícuota mapping, then file through ARCA (IVA Simple applies from November 2025)",
  // The AFIP F. 2002 web manual describes named grid items (solapas, ACCION
  // drill-downs), not numbered casillas, so the item names are used as codes.
  // Inventing numeric codes would be worse than naming them.
  boxes: [
    { lineCode: "DF_ALIC_21", label: "Débito fiscal — operaciones por actividad a la alícuota general 21%", sign: -1, sequence: 10 },
    { lineCode: "DF_ALIC_105", label: "Débito fiscal — operaciones por actividad a la alícuota reducida 10,5%", sign: -1, sequence: 20 },
    { lineCode: "DF_ALIC_27", label: "Débito fiscal — operaciones por actividad a la alícuota incrementada 27%", sign: -1, sequence: 30 },
    { lineCode: "CF_TOTAL", label: "Total del Crédito Fiscal", sign: 1, sequence: 40 },
    { lineCode: "SALDO_AFIP", label: "Saldo de Impuesto a favor de AFIP — saldo a pagar del período", sign: 1, sequence: 50 },
    { lineCode: "SALDO_CONTRIB", label: "Saldo de Libre Disponibilidad a favor del contribuyente del período — saldo a favor", sign: 1, sequence: 60 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 70, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 80, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Argentina IVA (Impuesto al Valor Agregado) localization. Currency: ARS.
 *
 * Agency naming: AFIP became ARCA (Agencia de Recaudación y Control
 * Aduanero) in 2024; source titles below carry the ARCA name with the
 * former AFIP name where the document itself predates the rename.
 *
 * Rate bands (Ley de IVA N.º 23.349, texto ordenado 1997, art. 28):
 * 21% general; 10.5% (half the general rate) on the listed primary goods;
 * 27% on gas, electricity, metered water and art. 3(e) points 4–6 supplied
 * outside dwellings to registered taxpayers. The 27% band sits ABOVE the
 * standard rate, so it carries no `role`: the role vocabulary
 * (standard/reduced/zero/exempt) has no term for a surcharge band, and
 * labelling it `standard` to fill the field would be false.
 *
 * Rate history is left-truncated to applicability: the consolidated text
 * states the current structure with no origin date, so each schedule opens
 * at the fetch date as applicability, not origin. Argentina's rate history
 * is long and heavily amended; no origin is claimed.
 *
 * Fetch refusals, named so the next person can finish the history: Infoleg
 * returned 403 to a bare client and loaded only with a browser user agent;
 * bare `afip.gob.ar` failed TLS hostname verification, so the F. 2002
 * manual was fetched from `www.afip.gob.ar` instead. No vendor page,
 * law-firm note or OECD summary was substituted for either.
 *
 * Lodgement is portal data entry, not a validated file upload: the F. 2002
 * web manual describes interactive Mis Aplicaciones Web entry (solapas,
 * editable grids, GRABAR). The SIAP-era F731 aplicativo is legacy and
 * attests nothing here. Since November 2025 ARCA requires responsables
 * inscriptos to file through the "IVA Simple" electronic procedure
 * (RG 5705/2025); the F. 2002 box structure is retained as this pack's
 * return basis.
 *
 * Out of scope by declaration: Ingresos Brutos is a provincial turnover
 * tax, genuinely subnational and genuinely not this pack's indirect tax;
 * the retenciones/percepciones and pagos-a-cuenta regimes are named and
 * nothing is declared for them. The 0% system-table value covers
 * non-taxed/exempt operations (the form's "Operaciones No Gravadas y
 * Exentas"), not a zero-rated refundable band, so no zero code is
 * declared.
 */
export const ARGENTINA_TAX_PACK: CountryTaxPackDefinition = {
  code: "AR_INDIRECT_TAX",
  version: "2026.08.01",
  country: "AR",
  name: "Argentina",
  countryTaxType: "vat",
  parentReturnPackCode: "AR_F2002",
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
      id: "infoleg_ley23349_art28",
      title: "Infoleg — Ley de IVA N.º 23.349, texto ordenado 1997, art. 28: 21% general, 27% utilities, 50% (10,5%) list (applicability, not origin)",
      url: "https://servicios.infoleg.gob.ar/infolegInternet/anexos/40000-44999/42701/texact.htm",
      asOf: "2026-09-18",
    },
    {
      id: "afip_f2002_web_manual",
      title: "AFIP (now ARCA) — Manual Mis Aplicaciones Web F. 2002 IVA por Actividad v1.0.0: solapas, débito por actividad y alícuota, liquidación grid",
      url: "https://www.afip.gob.ar/claveFiscal/manuales/documentos/dit.mis_aplicaciones_web.CF_MU_MAW_F2002-1.0.0.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "arca_tablas_alicuotas",
      title: "ARCA Biblioteca — Apartado E Tablas del Sistema: alícuotas de IVA 0%, 10,5%, 21%, 27%",
      url: "https://biblioteca.arca.gob.ar/search/query/adjunto.aspx?p=t:RAG|n:1361|o:3|a:2002|d:APARTADO_E_RG1440.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "arca_iva_simple",
      title: "ARCA (ex AFIP) — IVA Simple mandatory from November 2025 for responsables inscriptos (RG 5705/2025); F. 2002 superseded",
      url: "https://www.arca.gob.ar/iva/iva-simple/sujetos-operaciones-alcanzadas.asp",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [AR_F2002_2026],
  returnPackTaxCodes: {
    AR_F2002: [
      {
        code: "AR-VAT-STD",
        name: "Argentina IVA alícuota general",
        ratePercent: 21,
        role: "standard",
        rates: [{ ratePercent: 21, effectiveFrom: "2026-09-18", sourceId: "infoleg_ley23349_art28" }],
      },
      {
        code: "AR-VAT-RED105",
        name: "Argentina IVA alícuota reducida 10,5% — bienes primarios del art. 28",
        ratePercent: 10.5,
        role: "reduced",
        rates: [{ ratePercent: 10.5, effectiveFrom: "2026-09-18", sourceId: "infoleg_ley23349_art28" }],
      },
      {
        code: "AR-VAT-INC27",
        name: "Argentina IVA alícuota incrementada 27% — servicios públicos a responsables inscriptos",
        ratePercent: 27,
        rates: [{ ratePercent: 27, effectiveFrom: "2026-09-18", sourceId: "infoleg_ley23349_art28" }],
      },
    ],
  },
};
