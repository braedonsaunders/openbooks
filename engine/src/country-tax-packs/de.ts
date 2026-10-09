import { constructionReverseChargeRulesForCountry } from "./contractor-reverse-charge.ts";
import type { ContractorWithholdingSchemeDefinition, CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

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

/**
 * Bauabzugsteuer: the recipient of construction services withholds 15 % of
 * the consideration, VAT included, unless the provider presents a valid
 * Freistellungsbescheinigung, and files a monthly Anmeldung.
 */
const DE_BAUABZUG: ContractorWithholdingSchemeDefinition = {
  code: "DE_BAUABZUG",
  country: "DE",
  name: "Bauabzugsteuer (§ 48 EStG)",
  authority: "Finanzamt des Leistenden",
  legalReference: "§§ 48-48d Einkommensteuergesetz",
  currency: "EUR",
  // § 48 Abs. 3 EStG: the base is the Gegenleistung, the payment including
  // VAT, with no deduction for materials.
  base: { excludesMaterials: false, excludesVat: false },
  bands: [
    {
      code: "EXEMPT",
      name: "Freistellungsbescheinigung (§ 48b EStG) held",
      requiresVerification: true,
      verificationRequiresEndDate: true,
      rates: [{ ratePercent: "0", effectiveFrom: "2002-01-01", sourceId: "estg_48" }],
    },
    {
      code: "STANDARD",
      name: "No exemption certificate",
      requiresVerification: false,
      rates: [{ ratePercent: "15", effectiveFrom: "2002-01-01", sourceId: "estg_48" }],
    },
  ],
  defaultBandCode: "STANDARD",
  // § 48 Abs. 2 EStG: no deduction while the year's consideration to one
  // provider stays within the limit; 15 000 EUR where the recipient makes
  // exclusively VAT-exempt lettings under § 4 Nr. 12 UStG, else 5 000 EUR.
  threshold: {
    excludesVerifiedZeroRateConsideration: true,
    excessCatchUpNotDue: true,
    limits: [
      { amount: "5000", effectiveFrom: "2002-01-01", sourceId: "estg_48" },
      { amount: "15000", effectiveFrom: "2002-01-01", basis: "exempt_letting", sourceId: "estg_48" },
    ],
  },
  thresholdBases: [{ code: "exempt_letting", name: "Exclusively VAT-exempt letting (§ 4 Nr. 12 UStG)" }],
  // § 48a Abs. 1 EStG: the Anmeldung and the payment are due by the 10th of
  // the month following the month the consideration was paid.
  periodStartDay: 1,
  returnDue: { dayOfMonth: 10, monthsAfterPeriodEnd: 1 },
  paymentDue: { dayOfMonth: 10, monthsAfterPeriodEnd: 1 },
  paymentAuthorisation: "none",
  contractorReferenceLabel: "Steuernummer des Leistungsempfängers",
  payeeReferenceLabel: "Steuernummer des Leistenden",
  verificationLabel: "Freistellungsbescheinigung",
  sources: [
    {
      id: "bmf_bau_2022",
      title: "BMF 19 July 2022 — Bauabzugsteuer, paragraphs 51–52",
      url: "https://finanzamt.bayern.de/Informationen/download.php?url=Informationen%2FFormulare%2FWeitere_Themen_A_bis_Z%2FBauleistungen%2Fbmfs%2F2022-07-19-steuerabzug-von-verguetungen-fuer-im-inland-erbrachte-bauleistungen.pdf",
      asOf: "2026-10-08",
    },
    {
      id: "estg_48",
      title: "§ 48 EStG — Steuerabzug bei Bauleistungen",
      url: "https://www.gesetze-im-internet.de/estg/__48.html",
      asOf: "2026-10-08",
    },
    {
      id: "estg_48a",
      title: "§ 48a EStG — Verfahren",
      url: "https://www.gesetze-im-internet.de/estg/__48a.html",
      asOf: "2026-10-08",
    },
  ],
};

/** Germany VAT localization maintained from BMF and ELSTER primary sources. */
export const GERMANY_TAX_PACK: CountryTaxPackDefinition = {
  code: "DE_INDIRECT_TAX",
  version: "2026.08.01",
  country: "DE",
  reverseChargeRules: constructionReverseChargeRulesForCountry("DE"),
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
    DE_USTVA: [
      {
        code: "DE-VAT-STD",
        name: "Germany standard VAT",
        ratePercent: "19",
        role: "standard",
        rates: [
        { ratePercent: "10", effectiveFrom: "1968-01-01", effectiveTo: "1968-06-30", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: "11", effectiveFrom: "1968-07-01", effectiveTo: "1977-12-31", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: "12", effectiveFrom: "1978-01-01", effectiveTo: "1979-06-30", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: "13", effectiveFrom: "1979-07-01", effectiveTo: "1983-06-30", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: "14", effectiveFrom: "1983-07-01", effectiveTo: "1992-12-31", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: "15", effectiveFrom: "1993-01-01", effectiveTo: "1998-03-31", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: "16", effectiveFrom: "1998-04-01", effectiveTo: "2006-12-31", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: "19", effectiveFrom: "2007-01-01", effectiveTo: "2020-06-30", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: "16", effectiveFrom: "2020-07-01", effectiveTo: "2020-12-31", sourceId: "bmf_vat_rate_history_2026" },
        { ratePercent: "19", effectiveFrom: "2021-01-01", sourceId: "bmf_vat_rate_history_2026" },
        ],
      },
      {
        code: "DE-VAT-RED",
        name: "Germany reduced VAT",
        ratePercent: "7",
        role: "reduced",
        rates: [
          { ratePercent: "5", effectiveFrom: "1968-01-01", effectiveTo: "1968-06-30", sourceId: "bmf_vat_rate_history_2026" },
          { ratePercent: "5.5", effectiveFrom: "1968-07-01", effectiveTo: "1977-12-31", sourceId: "bmf_vat_rate_history_2026" },
          { ratePercent: "6", effectiveFrom: "1978-01-01", effectiveTo: "1979-06-30", sourceId: "bmf_vat_rate_history_2026" },
          { ratePercent: "6.5", effectiveFrom: "1979-07-01", effectiveTo: "1983-06-30", sourceId: "bmf_vat_rate_history_2026" },
          { ratePercent: "7", effectiveFrom: "1983-07-01", effectiveTo: "2020-06-30", sourceId: "bmf_vat_rate_history_2026" },
          { ratePercent: "5", effectiveFrom: "2020-07-01", effectiveTo: "2020-12-31", sourceId: "bmf_vat_rate_history_2026" },
          { ratePercent: "7", effectiveFrom: "2021-01-01", sourceId: "bmf_vat_rate_history_2026" },
        ],
      },
    ],
  },
  contractorWithholdingSchemes: [DE_BAUABZUG],
};
