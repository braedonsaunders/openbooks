import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const FI_ALV_2026: TaxReturnPack = {
  code: "FI_ALV",
  name: "ALV-ilmoitus — VAT return filed in OmaVero (MyTax)",
  country: "FI",
  jurisdiction: { code: "FI", name: "Finland — ALV territory", country: "FI", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/when-to-file-and-pay/",
  watermark: "Working copy — file in OmaVero; quarterly (turnover at most €100,000) and annual (at most €30,000) periods are turnover elections not modelled here; review Åland border treatment, then file",
  boxes: [
    { lineCode: "301", label: "301 — Tax on domestic sales at 25.5% (general rate; 24% before 1 September 2024)", sign: -1, sequence: 10 },
    { lineCode: "302", label: "302 — Tax on domestic sales at 13.5% (14% during 2025)", sign: -1, sequence: 20 },
    { lineCode: "303", label: "303 — Tax on domestic sales at 10% (newspapers and magazines)", sign: -1, sequence: 30 },
    { lineCode: "305", label: "305 — Tax on goods purchased from other EU countries", sign: 1, sequence: 40 },
    { lineCode: "306", label: "306 — Tax on services purchased from other EU countries", sign: 1, sequence: 50 },
    { lineCode: "307", label: "307 — Tax deductible for the tax period", sign: 1, sequence: 60 },
    { lineCode: "308", label: "308 — Tax payable / Negative tax that qualifies for refund (-)", sign: 1, sequence: 70, formula: "301 + 302 + 303 + 305 + 306 - 307" },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 80, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 90, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Finland ALV (arvonlisävero) localization.
 * Åland is inside Finnish ALV but outside the EU VAT area, so mainland–Åland
 * movements clear a tax border; no separate Åland return is declared here.
 * Out of scope by name: 304 (import VAT), 309–320 (turnover and base
 * information), 318 (construction/scrap reverse charge), small-business VAT
 * relief (ended for periods from 1 January 2025), and the quarterly/annual
 * turnover elections. The 308 formula covers the declared boxes only.
 */
export const FINLAND_TAX_PACK: CountryTaxPackDefinition = {
  code: "FI_INDIRECT_TAX",
  version: "2026.08.01",
  country: "FI",
  name: "Finland",
  countryTaxType: "vat",
  parentReturnPackCode: "FI_ALV",
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
      id: "vero_standard_rate_2024",
      title: "Vero — standard rate 24% to 25.5% on 1 September 2024 (24% applicability left-truncated at the January 2013 reform; the pre-2013 23% era is not transcribed)",
      url: "https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/rates-of-vat/the-changes-to-VAT-rates/",
      asOf: "2026-08-01",
    },
    {
      id: "vero_reduced_rates_2025_2026",
      title: "Vero — Rates of VAT: 10% band widened into 14% on 1 January 2025; 14% lowered to 13.5% on 1 January 2026; 10% kept for newspapers and magazines (food/restaurant 14% predates the transcribed tail)",
      url: "https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/rates-of-vat/",
      asOf: "2026-08-01",
    },
    {
      id: "vero_zero_rating_2026",
      title: "Vero — Rates of VAT: zero-rated categories (exports, intra-EU supply, vessels, warehousing) confirmed in force; transcribed tail starts at this confirmation, not at origin",
      url: "https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/rates-of-vat/",
      asOf: "2026-08-01",
    },
    {
      id: "vero_alv_return_filing",
      title: "Vero — Instructions for completing VAT returns: OmaVero return fields, monthly filing, due dates, and filing channels",
      url: "https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/when-to-file-and-pay/",
      asOf: "2026-08-01",
    },
    {
      id: "vero_vsralvkv_spec",
      title: "Vero — VSRALVKV data file specification v1.10: return field codes 301–308, 056 no-activity, and the 308 computation check",
      url: "https://vero.fi/contentassets/ef5905e0f5b74bcba89aa9ba9c34015d/finnish-tax-administration_description-of-the-data-file_vsralvkv_290824.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "vero_vat_tax_period",
      title: "Vero — tax period elections: quarterly at turnover of at most €100,000, annual at at most €30,000 (unmodelled elections; monthly is the default)",
      url: "https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/when-to-file-and-pay/tax-period/",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [FI_ALV_2026],
  returnPackTaxCodes: {
    FI_ALV: [
      {
        code: "FI-VAT-STD",
        name: "Finland standard ALV",
        ratePercent: 25.5,
        role: "standard",
        rates: [
          { ratePercent: 24, effectiveFrom: "2013-01-01", effectiveTo: "2024-08-31", sourceId: "vero_standard_rate_2024" },
          { ratePercent: 25.5, effectiveFrom: "2024-09-01", sourceId: "vero_standard_rate_2024" },
        ],
      },
      {
        code: "FI-VAT-RED135",
        name: "Finland reduced ALV 13.5% (food, restaurant, and the goods and services moved up from 10% in 2025)",
        ratePercent: 13.5,
        role: "reduced",
        rates: [
          { ratePercent: 14, effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31", sourceId: "vero_reduced_rates_2025_2026" },
          { ratePercent: 13.5, effectiveFrom: "2026-01-01", sourceId: "vero_reduced_rates_2025_2026" },
        ],
      },
      {
        code: "FI-VAT-RED10",
        name: "Finland reduced ALV 10% (newspapers and magazines)",
        ratePercent: 10,
        role: "reduced",
        rates: [
          // The 10% band predates 2025: the Vero rates page records that
          // most 10%-taxed supplies (books, medicines, transport,
          // accommodation, culture, sport) moved to 14% on 2025-01-01,
          // leaving newspapers, magazines and broadcasting at 10%. The
          // broad row opens at the January 2013 reform — the same
          // background the standard band's 24% row rests on, with the
          // pre-2013 9% era refused like the 23% era. Equal 10% values on
          // either side do NOT collapse: the 2025 narrowing repriced most
          // of the basket to 14%, so each row prices a different basket.
          { ratePercent: 10, effectiveFrom: "2013-01-01", effectiveTo: "2024-12-31", sourceId: "vero_reduced_rates_2025_2026" },
          { ratePercent: 10, effectiveFrom: "2025-01-01", sourceId: "vero_reduced_rates_2025_2026" },
        ],
      },
      {
        code: "FI-VAT-ZERO",
        name: "Finland zero-rated ALV (exports, intra-EU supply, vessels, warehousing)",
        ratePercent: 0,
        role: "zero",
        rates: [
          { ratePercent: 0, effectiveFrom: "2026-01-01", sourceId: "vero_zero_rating_2026" },
        ],
        // Zero-rated sales are reported in the ALV return's turnover and
        // base-information section (fields 309–320), which this pack
        // declares out of scope: within the modelled boxes the amounts land
        // only in the OB workpaper boxes.
        workpaperOnlyReason:
          "Zero-rated sales belong to the unmodelled ALV turnover/base section (fields 309–320, out of scope by declaration); no modelled government box carries them.",
      },
    ],
  },
};
