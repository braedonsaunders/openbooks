import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const PH_BIR_2550Q_2026: TaxReturnPack = {
  code: "PH_BIR_2550Q",
  name: "BIR Form No. 2550Q — Quarterly Value-Added Tax Return",
  country: "PH",
  jurisdiction: { code: "PH", name: "Philippines", country: "PH", level: "country", taxType: "vat" },
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.bir.gov.ph/eServices",
  watermark: "Working copy — confirm the taxable quarter, then file electronically via eFPS or eBIRForms",
  boxes: [
    { lineCode: "31", label: "Item 31 — VATable sales (exclusive of VAT) and output tax", sign: -1, sequence: 10 },
    { lineCode: "32", label: "Item 32 — Zero-rated sales", sign: 1, sequence: 20 },
    { lineCode: "34", label: "Item 34 — Total sales and output tax due", sign: -1, sequence: 30 },
    { lineCode: "37", label: "Item 37 — Total adjusted output tax due", sign: -1, sequence: 40 },
    { lineCode: "60", label: "Item 60 — Total allowable input tax", sign: 1, sequence: 50 },
    { lineCode: "61", label: "Item 61 — Net VAT payable/(excess input tax)", sign: 1, sequence: 60 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 70, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 80, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Philippines VAT localization.
 *
 * Currency is PHP; the pack carries no currency field. VAT is national, so
 * jurisdictions is empty. Percentage tax — the business tax for
 * non-VAT-registered persons below the VAT threshold — is a different tax,
 * not a VAT band, and nothing is declared for it.
 *
 * The pack declares ONLY the quarterly 2550Q. Section 37 of RA 10963 (TRAIN),
 * amending NIRC Section 114(A) and implemented by RR 13-2018, moved VAT to
 * mandatory quarterly filing from 1 January 2023: taxpayers are no longer
 * required to file the monthly 2550M and file the quarterly 2550Q instead, so
 * a pack declaring 2550M as the required return would model a filing that no
 * longer exists. Monthly 2550M filing survives only as an option with no
 * prescribed deadline (RMC 52-2023) — and anyone filing monthly must still
 * file the quarterly 2550Q — which is why 2550M gets no return pack here.
 *
 * VAT-exempt transactions (NIRC Section 109, reported on the form's Item 33)
 * are NOT zero-rated: no code is declared for them. There is no reduced rate.
 *
 * Rate histories are left-truncated to the April 2024 ENCS 2550Q guidelines
 * applicability the Bureau publishes (12% on goods, services, and
 * importations; 0% on export and other zero-rated sales). The 12% standard
 * rate dates to 1 February 2006 (from 10%, under RA 9337), but that origin is
 * deliberately not transcribed: www.officialgazette.gov.ph answers 403 from
 * this vantage (origin refused, not absent — retry from another network), and
 * the pre-migration RR 16-2005 / RMC 68-2005 full texts are no longer served
 * (their old /images/ paths return the site shell). The next person with
 * Official Gazette access can prepend the 10%-to-12% history. Leads checked
 * 2026-09-18 and left out: the Senate hosts the RA 9337 enrolled text at
 * web.senate.gov.ph/republic_acts/ra%209337.pdf but it answers 403 from
 * sandboxed vantages (retry unproxied — the act states the standby 12%
 * mechanism, though the 1/2/2006 effectivity itself needs RR 16-2005);
 * the Abakada decision (G.R. 168056) confirms the standby structure but is
 * not the publishing authority, so it cannot carry the band.
export const PHILIPPINES_TAX_PACK: CountryTaxPackDefinition = {
  code: "PH_INDIRECT_TAX",
  version: "2026.08.01",
  country: "PH",
  name: "Philippines",
  countryTaxType: "vat",
  parentReturnPackCode: "PH_BIR_2550Q",
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
      id: "bir_vat_information",
      title: "BIR — Value-Added Tax information: quarterly 2550Q filing, 12% and 0% rates, RMC 52-2023 optional monthly filing",
      url: "https://www.bir.gov.ph/value-addedtax",
      asOf: "2026-09-18",
    },
    {
      id: "bir_2550q_form_apr2024",
      title: "BIR — Form 2550Q April 2024 (ENCS): Part IV boxes 31, 32, 34, 37, 60, 61 applicability",
      url: "https://bir-cdn.bir.gov.ph/BIR/pdf/2550Q%20%20April%202024%20ENCS_Final.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "bir_2550q_guidelines_apr2024",
      title: "BIR — 2550Q guidelines April 2024: 12% rates and 0% export/zero-rated applicability, 25-day quarterly deadline, electronic filing",
      url: "https://bir-cdn.bir.gov.ph/BIR/pdf/2550Q%20guidelines%20April%202024_final.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "bir_rmc52_2023",
      title: "BIR — RMC No. 52-2023: TRAIN/RR 13-2018 quarterly mandate from 1 January 2023; 2550M monthly filing optional",
      url: "https://bir-cdn.bir.gov.ph/local/pdf/RMC%20No.%2052-2023%20(1).pdf",
      asOf: "2026-09-18",
    },
    {
      id: "bir_eservices_channels",
      title: "BIR — eServices: eFPS and eBIRForms filing channels applicability",
      url: "https://www.bir.gov.ph/eServices",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [PH_BIR_2550Q_2026],
  returnPackTaxCodes: {
    PH_BIR_2550Q: [
      {
        code: "PH-VAT-STD",
        name: "Philippines standard VAT 12%",
        ratePercent: 12,
        role: "standard",
        rates: [{ ratePercent: 12, effectiveFrom: "2024-04-01", sourceId: "bir_2550q_guidelines_apr2024" }],
      },
      {
        code: "PH-VAT-ZERO",
        name: "Philippines zero-rated VAT (export sales and other zero-rated sales)",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2024-04-01", sourceId: "bir_2550q_guidelines_apr2024" }],
      },
    ],
  },
};
