import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const RO_D300_2025: TaxReturnPack = {
  code: "RO_D300",
  name: "Declarația 300 — Decont de taxă pe valoarea adăugată",
  country: "RO",
  jurisdiction: { code: "RO", name: "Romania — national TVA territory", country: "RO", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "file_upload",
  governmentFormat: "certified_file",
  submissionUrl: "https://www.anaf.ro/",
  watermark: "Working copy — RON amounts; lodge via the ANAF SPV by the 25th; the quarterly threshold election is unmodelled",
  boxes: [
    { lineCode: "9", label: "Rândul 9 — livrări/prestări taxabile cu cota de 21% (TVA colectată)", sign: 1, sequence: 10 },
    { lineCode: "10", label: "Rândul 10 — livrări/prestări taxabile cu cota de 11% (TVA colectată)", sign: 1, sequence: 20 },
    { lineCode: "19", label: "Rândul 19 — total taxă colectată", sign: 1, sequence: 30 },
    { lineCode: "24", label: "Rândul 24 — achiziții taxabile cu cota de 21% (TVA deductibilă)", sign: 1, sequence: 40 },
    { lineCode: "25", label: "Rândul 25 — achiziții taxabile cu cota de 11% (TVA deductibilă)", sign: 1, sequence: 50 },
    { lineCode: "31", label: "Rândul 31 — total taxă deductibilă", sign: 1, sequence: 60 },
    { lineCode: "32", label: "Rândul 32 — subtotal taxă dedusă", sign: 1, sequence: 70 },
    { lineCode: "36", label: "Rândul 36 — total taxă dedusă", sign: 1, sequence: 80 },
    { lineCode: "37", label: "Rândul 37 — suma negativă de TVA în perioada de raportare", sign: 1, sequence: 90 },
    { lineCode: "38", label: "Rândul 38 — taxa de plată în perioada de raportare", sign: 1, sequence: 100 },
    { lineCode: "41", label: "Rândul 41 — TVA de plată cumulat", sign: 1, sequence: 110 },
    { lineCode: "44", label: "Rândul 44 — suma negativă de TVA cumulată", sign: 1, sequence: 120 },
    { lineCode: "45", label: "Rândul 45 — sold TVA de plată la sfârșitul perioadei de raportare", sign: 1, sequence: 130 },
    { lineCode: "46", label: "Rândul 46 — soldul sumei negative de TVA la sfârșitul perioadei de raportare", sign: 1, sequence: 140 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output TVA from the ledger, all configured rates", sign: -1, sequence: 150, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input TVA from the ledger, all configured rates", sign: 1, sequence: 160, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Romania TVA localization. Amounts in RON; TVA is national. The standard
 * band is transcribed as a contiguous 19%-from-2017 tail into 21% from
 * 1 August 2025 (Legea 141/2025); pre-2017 24%/20% bands are refused by
 * name. The former 9% and 5% reduced bands are refused by name: their
 * pre-reform supply membership cannot be sourced without guessing, and no
 * 5% or 9% band is current. Transitional D300 rows (19% corrections, 9%
 * housing to 31.07.2026, 5% residuals) and the OPANAF 174/2026 row
 * eliminations are likewise refused; only persistent rows are declared.
 * e-Factura and SAF-T (D406) are out of scope: named here, nothing
 * declared. Quarterly filing below the threshold is an unmodelled election.
 */
export const ROMANIA_TAX_PACK: CountryTaxPackDefinition = {
  code: "RO_INDIRECT_TAX",
  version: "2026.08.01",
  country: "RO",
  name: "Romania",
  countryTaxType: "vat",
  parentReturnPackCode: "RO_D300",
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
      id: "codul_fiscal_art291_19",
      title: "Legea nr. 227/2015 (Codul fiscal), art. 291 — standard 19% from 1 January 2017; 9%/5% reduced lists (applicability: left-truncated tail, not origin)",
      url: "https://static.anaf.ro/static/10/Anaf/legislatie/L_227_2015.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "mo_826_2025_d300",
      title: "Monitorul Oficial nr. 826/2025 — OPANAF 2131/2025: D300 model with 21%/11% rows, in force from August 2025 under Legea 141/2025",
      url: "https://legis.medleg.ro/api/legislation/2025-ordin-anaf-2131-2/export?format=pdf",
      asOf: "2026-08-01",
    },
    {
      id: "anaf_cluj_d300_2026",
      title: "ANAF Cluj 19.02.2026 — Legea 141/2025 rate reform; 9% housing transition to 31.07.2026; OPANAF 174/2026 removes transitional rows; electronic filing, 25th deadline",
      url: "https://static.anaf.ro/static/3/Cluj/20260220114126_cj_d300_20feb2026.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "sovos_ro_vat_aug2025",
      title: "Sovos 18.08.2025 (corroboration) — standard 19% to 21%, 5% and 9% consolidated to 11% from 1 August 2025, with exceptions",
      url: "https://sovos.com/regulatory-updates/vat/romania-raises-vat-rates-effective-august-1/",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [RO_D300_2025],
  returnPackTaxCodes: {
    RO_D300: [
      {
        code: "RO-VAT-STD",
        name: "Romania standard TVA",
        ratePercent: 21,
        role: "standard",
        rates: [
          { ratePercent: 19, effectiveFrom: "2017-01-01", effectiveTo: "2025-07-31", sourceId: "codul_fiscal_art291_19" },
          { ratePercent: 21, effectiveFrom: "2025-08-01", sourceId: "mo_826_2025_d300" },
        ],
      },
      {
        code: "RO-VAT-RED11",
        name: "Romania reduced TVA 11%",
        ratePercent: 11,
        role: "reduced",
        rates: [{ ratePercent: 11, effectiveFrom: "2025-08-01", sourceId: "mo_826_2025_d300" }],
      },
    ],
  },
};
