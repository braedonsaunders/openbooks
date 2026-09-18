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
 *
 * Rate histories open at the FPS VAT-rates applicability page (verified
 * 2026-09-18), not at the 1996 20.5%-to-21% changeover: FPS publishes no
 * rate history, so the Linklaters-via-Mondaq changeover note, the OECD
 * Consumption Tax Trends summary and the Microsoft box cross-reference
 * were dropped rather than blessed. A shorter FPS-sourced history beats a
 * longer one resting on a law firm's summary.
 *
 * The changeover is IDENTIFIED but its text has never been read by us, so it
 * is not transcribed. The 21% rate is said to apply from 1 January 1996 under
 * the Loi du 22 décembre 1995 (M.B. 30.12.1995), replacing 20.5%, but that is
 * sourced only to a teaching copy of the Code TVA — unverified at gazette
 * level.
 *
 * Both routes to the primary text are closed to automated clients, and the
 * second one is worth stating precisely because it produced a false positive:
 *
 * - finance.belgium.be serves plain clients a JS/image-captcha challenge, so
 *   no deeper FPS history is fetchable. (Note finances.belgium.be, with the s,
 *   does load and carries current applicability only.)
 * - www.ejustice.just.fgov.be — the authority's own Justel/Moniteur host —
 *   returns HTTP 200 with a large body that is an Imperva bot challenge, NOT
 *   the law. A 49,663-byte response here was initially read as "a real Justel
 *   document"; parsing it yields 2,103 characters of "Please enable JavaScript
 *   to view the page content… What code is in the image?" and a /TSPD/
 *   endpoint. This was confirmed from an unproxied vantage too, so it is the
 *   edge WAF refusing non-browser clients generally, not a sandbox artifact.
 *   The bare apex ejustice.just.fgov.be has no listener at all.
 *
 * DO NOT prepend a 1996 band on the strength of a host becoming reachable or
 * allowlisted. The blocker is not access, it is that nobody has read the
 * operative sentence. Transcribe it only when someone can quote the language
 * stating 20,5% → 21% and its commencement date from the instrument itself;
 * a status code and a byte count are not a citation. The 12% and 6% bands are
 * long-standing but need their own gazette dates — do not backfill them from
 * the 21% act.
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
      id: "fps_vat_rates",
      title: "FPS Finance — VAT rates: standard 21% (R03), intermediate 12% (R02), reduced 6% (R01); zero rate (R00) for exceptional goods and services (applicability, not origin)",
      url: "https://finance.belgium.be/en/enterprises/vat/vat-obligation/rates-and-calculation/vat-rates",
      asOf: "2026-09-18",
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
        rates: [{ ratePercent: 21, effectiveFrom: "2026-09-18", sourceId: "fps_vat_rates" }],
      },
      {
        code: "BE-VAT-RED12",
        name: "Belgium reduced VAT 12%",
        ratePercent: 12,
        role: "reduced",
        rates: [{ ratePercent: 12, effectiveFrom: "2026-09-18", sourceId: "fps_vat_rates" }],
      },
      {
        code: "BE-VAT-RED6",
        name: "Belgium reduced VAT 6%",
        ratePercent: 6,
        role: "reduced",
        rates: [{ ratePercent: 6, effectiveFrom: "2026-09-18", sourceId: "fps_vat_rates" }],
      },
    ],
  },
};
