import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const BE_VAT_PERIODIC_2026: TaxReturnPack = {
  code: "BE_VAT_PERIODIC",
  name: "Déclaration TVA périodique / Periodieke btw-aangifte 2026",
  country: "BE",
  jurisdiction: { code: "BE", name: "Belgium — TVA/BTW territory", country: "BE", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "file_upload",
  governmentFormat: "certified_file",
  submissionUrl: "https://finance.belgium.be/en/E-services/Intervat/how-to-use-intervat/submit-periodic-return",
  watermark: "Working copy — lodge through Intervat as an XML file or on-screen; monthly filing is the general rule and quarterly filing is an election below the turnover threshold that this pack does not model",
  boxes: [
    { lineCode: "01", label: "Grille 01 — taxable base for supplies and services at 6%", sign: 1, sequence: 10 },
    { lineCode: "02", label: "Grille 02 — taxable base for supplies and services at 12%", sign: 1, sequence: 20 },
    { lineCode: "03", label: "Grille 03 — taxable base for supplies and services at 21%", sign: 1, sequence: 30 },
    { lineCode: "54", label: "Grille 54 — VAT due on the turnover in grilles 01, 02 and 03", sign: 1, sequence: 40 },
    { lineCode: "59", label: "Grille 59 — deductible VAT", sign: 1, sequence: 50 },
    { lineCode: "71", label: "Grille 71 — balance payable to the State", sign: 1, sequence: 60 },
    { lineCode: "72", label: "Grille 72 — balance recoverable from the State", sign: 1, sequence: 70 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 80, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 90, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Belgium TVA/BTW localization.
 *
 * Monthly filing is the general rule; quarterly filing is an election for
 * businesses under the EUR 2.5M turnover threshold (with lower sub-caps and
 * an intra-Community-supplies exclusion) and this pack does not model the
 * election.
 *
 * NOT modelled: the reduced-rate construction/demolition and renovation
 * regimes, the cocontractant (reverse-charge) grids, and the annual client
 * listing (liste annuelle des clients / jaarlijkse klantenlisting). No 0%
 * band is declared: the periodic declaration carries no 0% output base grid
 * (01/02/03 cover 6%/12%/21%), even though a 0% rate exists in rate tables.
 * VAT is federal: Flanders, Wallonia and Brussels levy no VAT.
 */
export const BELGIUM_TAX_PACK: CountryTaxPackDefinition = {
  code: "BE_INDIRECT_TAX",
  version: "2026.08.01",
  country: "BE",
  name: "Belgium",
  countryTaxType: "vat",
  parentReturnPackCode: "BE_VAT_PERIODIC",
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
      id: "fps_periodic_return",
      title: "FPS Finance — periodic VAT return: monthly filing is the general rule, quarterly is an election",
      url: "https://finance.belgium.be/en/enterprises/vat/declaration/periodic-return",
      asOf: "2026-08-01",
    },
    {
      id: "fps_intervat_submit",
      title: "FPS Finance — submit a periodic return through Intervat by XML file or on screen",
      url: "https://finance.belgium.be/en/E-services/Intervat/how-to-use-intervat/submit-periodic-return",
      asOf: "2026-08-01",
    },
    {
      id: "ms_intervat_boxes",
      title: "Microsoft Learn — INTERVAT declaration box table (secondary cross-reference for grilles 01/02/03, 54, 59, 71/72)",
      url: "https://learn.microsoft.com/en-us/dynamics365/finance/localizations/belgium/emea-bel-intervat-tax-declaration",
      asOf: "2026-08-01",
    },
    {
      id: "oecd_rate_history_1996",
      title: "OECD Consumption Tax Trends Belgium — 21% standard since 1996 (20.5% in 1995); reduced 6%/12% bands in force",
      url: "https://www.oecd.org/content/dam/oecd/en/topics/policy-sub-issues/consumption-tax-trends/consumption-tax-trends-belgium.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "mondaq_1996_changeover",
      title: "Linklaters via Mondaq (1995) — 20.5% to 21% on 1 January 1996; 6%/12% bands unchanged (left-truncated applicability, not origin)",
      url: "https://www.mondaq.com/audit/38/tax-law---new-standard-vat-rate-in-belgium",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [BE_VAT_PERIODIC_2026],
  returnPackTaxCodes: {
    BE_VAT_PERIODIC: [
      {
        code: "BE-VAT-STD",
        name: "Belgium standard VAT",
        ratePercent: 21,
        role: "standard",
        rates: [{ ratePercent: 21, effectiveFrom: "1996-01-01", sourceId: "mondaq_1996_changeover" }],
      },
      {
        code: "BE-VAT-RED12",
        name: "Belgium reduced VAT 12%",
        ratePercent: 12,
        role: "reduced",
        rates: [{ ratePercent: 12, effectiveFrom: "1996-01-01", sourceId: "mondaq_1996_changeover" }],
      },
      {
        code: "BE-VAT-RED6",
        name: "Belgium reduced VAT 6%",
        ratePercent: 6,
        role: "reduced",
        rates: [{ ratePercent: 6, effectiveFrom: "1996-01-01", sourceId: "mondaq_1996_changeover" }],
      },
    ],
  },
};
