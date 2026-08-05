import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const DE_USTVA_2026: TaxReturnPack = {
  code: "DE_USTVA",
  name: "Umsatzsteuer-Voranmeldung 2026 (USt 1 A)",
  country: "DE",
  jurisdiction: { code: "DE", name: "Germany", country: "DE", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "file_upload",
  governmentFormat: "certified_file",
  submissionUrl: "https://www.elster.de/eportal/formulare-leistungen/alleformulare/ustvaeru",
  watermark: "Working copy — transmit electronically through ELSTER; official field eligibility and adjustments require filer review",
  boxes: [
    { lineCode: "81", label: "Kz 81 — taxable supplies at 19%: net assessment base", sign: 1, sequence: 10 },
    { lineCode: "86", label: "Kz 86 — taxable supplies at 7%: net assessment base", sign: 1, sequence: 20 },
    { lineCode: "87", label: "Kz 87 — taxable supplies at 0%: net assessment base", sign: 1, sequence: 30 },
    { lineCode: "41", label: "Kz 41 — intra-Community supplies to customers with a VAT identification number", sign: 1, sequence: 40 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all rates", sign: -1, sequence: 50, basis: "tax_collected", glMap: "sales" },
    { lineCode: "66", label: "Kz 66 — deductible input VAT from invoices from other businesses", sign: 1, sequence: 60 },
    { lineCode: "61", label: "Kz 61 — deductible input VAT on intra-Community acquisitions", sign: 1, sequence: 70 },
    { lineCode: "62", label: "Kz 62 — incurred import VAT", sign: 1, sequence: 80 },
    { lineCode: "67", label: "Kz 67 — deductible input VAT on supplies under § 13b UStG", sign: 1, sequence: 90 },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all rates", sign: 1, sequence: 100, basis: "tax_paid", glMap: "purchases" },
    { lineCode: "83", label: "Kz 83 — remaining VAT advance payment or surplus", sign: 1, sequence: 110 },
  ],
};

/** Germany VAT localization maintained from BMF and ELSTER primary sources. */
export const GERMANY_TAX_PACK: CountryTaxPackDefinition = {
  code: "DE_INDIRECT_TAX",
  version: "2026.08.01",
  country: "DE",
  name: "Germany",
  countryTaxType: "vat",
  parentReturnPackCode: "DE_USTVA",
  completeness: {
    jurisdictions: "not_applicable",
    standardRates: "complete",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "bmf_vat_rate_history_2026",
      title: "Federal Ministry of Finance — tax-policy data 2026, VAT rate history",
      url: "https://www.bundesfinanzministerium.de/Content/DE/Downloads/Broschueren_Bestellservice/datensammlung-zur-steuerpolitik-2026.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "bmf_ustva_2026",
      title: "Federal Ministry of Finance — official 2026 Umsatzsteuer-Voranmeldung forms and instructions",
      url: "https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/2025-12-29-vordruckmuster-USt-voranmeldung-2026.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "elster_ustva_2026",
      title: "ELSTER — 2026 Umsatzsteuer-Voranmeldung help",
      url: "https://www.elster.de/elsterweb/helpGlobal?themaGlobal=help_ustva_2026",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [DE_USTVA_2026],
  returnPackTaxCodes: {
    DE_USTVA: {
      code: "DE-VAT-STD",
      name: "Germany standard VAT",
      ratePercent: 19,
      rates: [
        { ratePercent: 10, effectiveFrom: "1968-01-01", effectiveTo: "1968-06-30", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: 11, effectiveFrom: "1968-07-01", effectiveTo: "1977-12-31", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: 12, effectiveFrom: "1978-01-01", effectiveTo: "1979-06-30", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: 13, effectiveFrom: "1979-07-01", effectiveTo: "1983-06-30", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: 14, effectiveFrom: "1983-07-01", effectiveTo: "1992-12-31", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: 15, effectiveFrom: "1993-01-01", effectiveTo: "1998-03-31", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: 16, effectiveFrom: "1998-04-01", effectiveTo: "2006-12-31", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: 19, effectiveFrom: "2007-01-01", effectiveTo: "2020-06-30", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: 16, effectiveFrom: "2020-07-01", effectiveTo: "2020-12-31", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: 19, effectiveFrom: "2021-01-01", sourceId: "bmf_vat_rate_history_2026" },
      ],
    },
  },
};
