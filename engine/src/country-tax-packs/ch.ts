import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const CH_MWST_ABRECHNUNG_2026: TaxReturnPack = {
  code: "CH_MWST_ABRECHNUNG",
  name: "MWST-Abrechnung — effective method 2026",
  country: "CH",
  jurisdiction: { code: "CH", name: "Switzerland — MWST territory", country: "CH", level: "country", taxType: "vat" },
  // Effective-settlement default. Monthly and semi-annual settlement exist as
  // elections with the ESTV; the pack does not yet model them.
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.estv.admin.ch/de/mwst-online-abrechnen",
  watermark: "Working copy — file through MWST-Abrechnung pro in the ESTV portal; Saldo-/Pauschalsteuersatz methods require filer review",
  boxes: [
    { lineCode: "200", label: "Ziff. 200 — agreed or collected consideration worldwide, incl. opted supplies (worldwide turnover)", sign: 1, sequence: 10 },
    { lineCode: "205", label: "Ziff. 205 — therein: supplies opted for taxation under art. 22 (subset of Ziff. 200)", sign: 1, sequence: 20 },
    { lineCode: "220", label: "Ziff. 220 — supplies exempt with credit, e.g. export (art. 23)", sign: 1, sequence: 30 },
    { lineCode: "221", label: "Ziff. 221 — supplies provided abroad (place of supply abroad)", sign: 1, sequence: 40 },
    { lineCode: "225", label: "Ziff. 225 — transfers under the notification procedure (art. 38)", sign: 1, sequence: 50 },
    { lineCode: "230", label: "Ziff. 230 — domestic supplies exempt without credit (art. 21, no option exercised)", sign: 1, sequence: 60 },
    { lineCode: "235", label: "Ziff. 235 — reductions of consideration (discounts, rebates)", sign: 1, sequence: 70 },
    { lineCode: "280", label: "Ziff. 280 — miscellaneous (e.g. land value, margin-taxation purchase prices)", sign: 1, sequence: 80 },
    { lineCode: "289", label: "Ziff. 289 — total deductions (Ziff. 220 to 280)", sign: 1, sequence: 90 },
    { lineCode: "299", label: "Ziff. 299 — taxable turnover (Ziff. 200 minus Ziff. 289)", sign: 1, sequence: 100 },
    { lineCode: "303", label: "Ziff. 303 — standard rate 8.1% (from 01.01.2024)", sign: -1, sequence: 110 },
    { lineCode: "302", label: "Ziff. 302 — standard rate 7.7% (transition row for supplies to 31.12.2023)", sign: -1, sequence: 120 },
    { lineCode: "313", label: "Ziff. 313 — reduced rate 2.6% (from 01.01.2024)", sign: -1, sequence: 130 },
    { lineCode: "312", label: "Ziff. 312 — reduced rate 2.5% (transition row for supplies to 31.12.2023)", sign: -1, sequence: 140 },
    { lineCode: "343", label: "Ziff. 343 — special rate for accommodation 3.8% (from 01.01.2024)", sign: -1, sequence: 150 },
    { lineCode: "342", label: "Ziff. 342 — special rate for accommodation 3.7% (transition row for supplies to 31.12.2023)", sign: -1, sequence: 160 },
    { lineCode: "383", label: "Ziff. 383 — acquisition tax / Bezugsteuer (from 01.01.2024)", sign: -1, sequence: 170 },
    { lineCode: "382", label: "Ziff. 382 — acquisition tax / Bezugsteuer (transition row for supplies to 31.12.2023)", sign: -1, sequence: 180 },
    { lineCode: "399", label: "Ziff. 399 — total tax due (Ziff. 302 to 383)", sign: -1, sequence: 190 },
    { lineCode: "400", label: "Ziff. 400 — input tax on materials and services", sign: 1, sequence: 200 },
    { lineCode: "405", label: "Ziff. 405 — input tax on investments and other operating costs", sign: 1, sequence: 210 },
    { lineCode: "410", label: "Ziff. 410 — de-taxation on contributions in kind (art. 32)", sign: 1, sequence: 220 },
    { lineCode: "415", label: "Ziff. 415 — input-tax correction: mixed use (art. 30), own use (art. 31)", sign: 1, sequence: 230 },
    { lineCode: "420", label: "Ziff. 420 — input-tax reduction: subsidies and similar non-consideration funds (art. 33 para. 2)", sign: 1, sequence: 240 },
    { lineCode: "479", label: "Ziff. 479 — total input tax (Ziff. 400 to 420)", sign: 1, sequence: 250 },
    { lineCode: "500", label: "Ziff. 500 — amount payable to the ESTV", sign: -1, sequence: 260 },
    { lineCode: "510", label: "Ziff. 510 — credit in favour of the taxable person", sign: 1, sequence: 270 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 280, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 290, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Switzerland MWST localization (effective method only).
 *
 * Currency is CHF; the pack carries no currency field. MWST is federal —
 * cantons levy no VAT. Liechtenstein shares the Swiss MWST territory under
 * the customs treaty; it gets no separate pack or jurisdiction here.
 * Rate histories left-truncate at 2001-01-01 (the contiguous 7.6% → 8.0% →
 * 7.7% → 8.1% tail); pre-2001 rates stay out of scope.
 */
export const SWITZERLAND_TAX_PACK: CountryTaxPackDefinition = {
  code: "CH_INDIRECT_TAX",
  version: "2026.08.01",
  country: "CH",
  name: "Switzerland",
  countryTaxType: "vat",
  parentReturnPackCode: "CH_MWST_ABRECHNUNG",
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
      id: "estv_rates_current",
      title: "ESTV — Schweizer Mehrwertsteuersätze: Normalsatz 8,1 %, reduzierter Satz 2,6 %, Sondersatz Beherbergung 3,8 %",
      url: "https://www.estv.admin.ch/de/mwst-steuersaetze-schweiz",
      asOf: "2026-09-18",
    },
    {
      id: "estv_rate_increase_2024",
      title: "ESTV — MWST-Steuersatzerhöhung per 1. Januar 2024 (AHV financing: 7,7 % → 8,1 %, 2,5 % → 2,6 %, 3,7 % → 3,8 %)",
      url: "https://www.estv.admin.ch/de/erhoehung-mwst-steuersaetze-2024",
      asOf: "2026-09-18",
    },
    {
      id: "bazg_rate_history",
      title: "BAZG — Mehrwertsteuersätze table, Publ. 52.15 (06.2023): dated applicability of the 2001, 2011 and 2018 rate steps",
      url: "https://www.bazg.admin.ch/dam/de/sd-web/6IIiloptXCOn/52_15_mehrwertsteuersaetze.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "estv_return_sample_2024",
      title: "ESTV — MWST-Abrechnung Muster 2024 (effective method): official return Ziffern 200–510",
      url: "https://www.estv2.admin.ch/mwst/formulare/mwst-form-abr-muster-2024-eff-en.pdf",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [CH_MWST_ABRECHNUNG_2026],
  returnPackTaxCodes: {
    CH_MWST_ABRECHNUNG: [
      {
        code: "CH-VAT-STD",
        name: "Switzerland MWST standard rate",
        ratePercent: 8.1,
        role: "standard",
        rates: [
          { ratePercent: 7.6, effectiveFrom: "2001-01-01", effectiveTo: "2010-12-31", sourceId: "bazg_rate_history" },
          { ratePercent: 8, effectiveFrom: "2011-01-01", effectiveTo: "2017-12-31", sourceId: "bazg_rate_history" },
          { ratePercent: 7.7, effectiveFrom: "2018-01-01", effectiveTo: "2023-12-31", sourceId: "bazg_rate_history" },
          { ratePercent: 8.1, effectiveFrom: "2024-01-01", sourceId: "estv_rate_increase_2024" },
        ],
      },
      {
        code: "CH-VAT-RED",
        name: "Switzerland MWST reduced rate (food, books, medicines)",
        ratePercent: 2.6,
        role: "reduced",
        rates: [
          { ratePercent: 2.4, effectiveFrom: "2001-01-01", effectiveTo: "2010-12-31", sourceId: "bazg_rate_history" },
          { ratePercent: 2.5, effectiveFrom: "2011-01-01", effectiveTo: "2023-12-31", sourceId: "bazg_rate_history" },
          { ratePercent: 2.6, effectiveFrom: "2024-01-01", sourceId: "estv_rate_increase_2024" },
        ],
      },
      {
        code: "CH-VAT-LODGING",
        name: "Switzerland MWST special rate for accommodation (Sondersatz für Beherbergung)",
        ratePercent: 3.8,
        role: "reduced",
        rates: [
          { ratePercent: 3.6, effectiveFrom: "2001-01-01", effectiveTo: "2010-12-31", sourceId: "bazg_rate_history" },
          { ratePercent: 3.8, effectiveFrom: "2011-01-01", effectiveTo: "2017-12-31", sourceId: "bazg_rate_history" },
          { ratePercent: 3.7, effectiveFrom: "2018-01-01", effectiveTo: "2023-12-31", sourceId: "bazg_rate_history" },
          { ratePercent: 3.8, effectiveFrom: "2024-01-01", sourceId: "estv_rate_increase_2024" },
        ],
      },
    ],
  },
};
