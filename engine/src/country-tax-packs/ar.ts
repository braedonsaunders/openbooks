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
 * Rate history runs back to 1992-03-01 on the standard band, one row per
 * rate change, all drawn from Infoleg's own EVOLUCION DE LAS ALICUOTAS table
 * on the texto ordenado: 18% under Ley 23.966 from 1/3/92 (restored with the
 * 27% differential by the table's note 2) to 31/3/95; 21% under Ley 24.468
 * from 1/04/95 to 31/3/96 (art. 3 raised the rate three points for one year,
 * corroborated on that law's Infoleg page, BO 23/3/95); 21% under Ley 24.631
 * from 01/04/96 (VAT modification, BO 27/3/96 — the restoration that picked
 * up exactly where the one-year grant expired, so there is no gap); 19%
 * under Decreto 2312/2002 from 18/11/02 to 17/01/03 (temporary cut recorded
 * in Infoleg's art-28 note); 21% again from 18/01/03, open. The 1996 and
 * 2002 boundaries are distinct-temporary-instrument boundaries — the 1995
 * grant expired and a separate law restored the rate; the 2002 cut was a
 * temporary decree — so equal 21% values on either side do NOT collapse;
 * the 2003 reversion is the same continuing law and collapses into the open
 * row. The 10.5% band is 50% of the general rate by art. 28's own rule, so
 * it tracks the 2002 window as 9.5% and reverts with it; pre-2002 10.5%
 * history is refused (the 50%-rule origin and any 9% era under the 18%
 * general rate are unsourced). The 27% band opens 1992-03-01: Infoleg's
 * EVOLUCION table restores the 27% differential alongside the 18% general
 * rate under Ley 23.966 (the table's note 2), and the utilities band is
 * that differential's continuation — so provisioning no longer refuses
 * pre-fetch 27% documents. Pre-1992 decree-era bands are refused: the
 * table's 1988–1992 columns cannot be mapped unambiguously.
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
      title: "Infoleg — Ley de IVA N.º 23.349, texto ordenado 1997, art. 28: 21% general, 27% utilities, 50% (10,5%) list, with Infoleg's EVOLUCION DE LAS ALICUOTAS table (Ley 23.966 18% from 1/3/92; Ley 24468 21% from 1/04/95; Ley 24.631 21% from 01/04/96) and art-28 notes (Decreto 2312/2002 temporary 19% window 18/11/2002–17/01/2003, 50% computed on the reduced rate)",
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
        rates: [
          { ratePercent: 18, effectiveFrom: "1992-03-01", effectiveTo: "1995-03-31", sourceId: "infoleg_ley23349_art28" },
          { ratePercent: 21, effectiveFrom: "1995-04-01", effectiveTo: "1996-03-31", sourceId: "infoleg_ley23349_art28" },
          { ratePercent: 21, effectiveFrom: "1996-04-01", effectiveTo: "2002-11-17", sourceId: "infoleg_ley23349_art28" },
          { ratePercent: 19, effectiveFrom: "2002-11-18", effectiveTo: "2003-01-17", sourceId: "infoleg_ley23349_art28" },
          { ratePercent: 21, effectiveFrom: "2003-01-18", sourceId: "infoleg_ley23349_art28" },
        ],
      },
      {
        code: "AR-VAT-RED105",
        name: "Argentina IVA alícuota reducida 10,5% — bienes primarios del art. 28",
        ratePercent: 10.5,
        role: "reduced",
        rates: [
          { ratePercent: 9.5, effectiveFrom: "2002-11-18", effectiveTo: "2003-01-17", sourceId: "infoleg_ley23349_art28" },
          { ratePercent: 10.5, effectiveFrom: "2003-01-18", sourceId: "infoleg_ley23349_art28" },
        ],
      },
      {
        code: "AR-VAT-INC27",
        name: "Argentina IVA alícuota incrementada 27% — servicios públicos a responsables inscriptos",
        ratePercent: 27,
        rates: [{ ratePercent: 27, effectiveFrom: "1992-03-01", sourceId: "infoleg_ley23349_art28" }],
      },
    ],
  },
};
