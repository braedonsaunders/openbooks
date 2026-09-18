import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const AT_U30_2026: TaxReturnPack = {
  code: "AT_U30",
  name: "Umsatzsteuervoranmeldung (U 30) — USt advance return",
  country: "AT",
  jurisdiction: { code: "AT", name: "Austria — USt territory", country: "AT", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://finanzonline.bmf.gv.at/",
  watermark: "Working copy — review reverse-charge, intra-EU and special-scheme treatment, then file through FinanzOnline",
  boxes: [
    { lineCode: "000", label: "KZ 000 — Gesamtbetrag der Bemessungsgrundlage für Lieferungen und sonstige Leistungen", sign: 1, sequence: 10 },
    { lineCode: "022", label: "KZ 022 — Bemessungsgrundlage 20% Normalsteuersatz", sign: 1, sequence: 20 },
    { lineCode: "029", label: "KZ 029 — Bemessungsgrundlage 10% ermäßigter Steuersatz", sign: 1, sequence: 30 },
    { lineCode: "006", label: "KZ 006 — Bemessungsgrundlage 13% ermäßigter Steuersatz", sign: 1, sequence: 40 },
    { lineCode: "060", label: "KZ 060 — Gesamtbetrag der abziehbaren Vorsteuern", sign: 1, sequence: 50 },
    { lineCode: "095", label: "KZ 095 — Vorauszahlung (Zahllast) / Überschuss (Gutschrift)", sign: 1, sequence: 60 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 70, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 80, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Austria USt (Umsatzsteuer) localization, served end to end by the U30
 * Umsatzsteuervoranmeldung filed through FinanzOnline.
 *
 * Filing frequency: monthly is the default declared here. Below the
 * turnover thresholds the obligation drops to quarterly (prior-year
 * turnover EUR 55,000–100,000) or to no filing at all (below EUR 55,000
 * with the prepayment paid by the due date) — that quarterly/below-
 * threshold election is unmodelled, not declared. The annual U1
 * Umsatzsteuererklärung is out of scope and also undeclared.
 *
 * Jungholz and Mittelberg apply 19% under the German customs union. That
 * is a genuine territorial rate stated on the BMF U30 form itself
 * (section 4.17, KZ 037), so it is declared as AT-VAT-ENCLAVE on the same
 * return with no role — it is neither standard nor reduced in the
 * Austrian schedule — and with no jurisdictions[] entry: the enclaves
 * file the same U30.
 *
 * Refused by name: the 4.9% band the USP rates page lists for selected
 * foods (no U30 Kennzahl serves it); the 12% Ab-Hof-Wein band the 2016
 * reform abolished (historical, no current box); the 7%/10% Zusatzsteuer
 * for pauschalierte land- und forstwirtschaftliche Betriebe (KZ 052/007,
 * flat-rate farmer scheme, unmodelled); and the reverse-charge /
 * intra-EU-acquisition auxiliary lines (KZ 021/032/048/057/070–089 and
 * the section 6 correction KZ 090), which this pack does not serve.
 *
 * Sourcing refusals: the 20/10/13 schedules open at USP applicability
 * (2026-08-01), not at the 2016 reform — the Steuerreform 2015/2016 did
 * move 10% goods (and the 12% wine band) to 13%, corroborated by the
 * Parliament Budgetdienst reform analysis, but no day-one date is
 * verifiable in reachable primary text (RIS serves no BGBl here; the BMF
 * formularservice hosts no 2016 vintage), so the tax-advisor reform sheet
 * was dropped rather than kept as the date's only witness. The enclave
 * KZ 037 claim still rests on the BMF's own U30 form via the statutory
 * chamber's mirror (wko.at): the formularservice does not host that
 * vintage and the U30a instructions do not document KZ 037 — a named
 * mirror exception in the wave4 proof, re-verify if BMF publishes it.
 */
export const AUSTRIA_TAX_PACK: CountryTaxPackDefinition = {
  code: "AT_INDIRECT_TAX",
  version: "2026.08.01",
  country: "AT",
  name: "Austria",
  countryTaxType: "vat",
  parentReturnPackCode: "AT_U30",
  completeness: {
    jurisdictions: "not_applicable",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "not_applicable",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "bmf_u30_2023",
      title: "BMF — U30 Umsatzsteuervoranmeldung 2023 (form U 30-PDF-2023, version 16.12.2022; box applicability)",
      url: "https://www.wko.at/ooe/aussenwirtschaft/importhandbuch/u30-formular-umsatzsteuervoranmeldung.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "bmf_u30a_2026",
      title: "BMF — Ausfüllhilfe zur Umsatzsteuervoranmeldung (U 30a) für 2026 (filing thresholds and FinanzOnline duty)",
      url: "https://formulare.bmf.gv.at/service/formulare/inter-Steuern/pdfd/2026/U30a.pdf",
      asOf: "2026-08-01",
    },
    {
      id: "usp_ust_rates",
      title: "USP (BMF-responsible) — Steuersätze und Steuerbefreiungen der Umsatzsteuer (20/10/13 bands; schedules open at this applicability, not origin)",
      url: "https://www.usp.gv.at/themen/steuern-finanzen/umsatzsteuer-ueberblick/steuersaetze-und-steuerbefreiungen-der-umsatzsteuer.html",
      asOf: "2026-08-01",
    },
    {
      id: "finanzonline",
      title: "BMF — FinanzOnline portal (U30 electronic filing channel)",
      url: "https://finanzonline.bmf.gv.at/",
      asOf: "2026-08-01",
    },
  ],
  jurisdictions: [],
  returnPacks: [AT_U30_2026],
  returnPackTaxCodes: {
    AT_U30: [
      {
        code: "AT-VAT-STD",
        name: "Austria USt standard rate",
        ratePercent: 20,
        role: "standard",
        rates: [{ ratePercent: 20, effectiveFrom: "2026-08-01", sourceId: "usp_ust_rates" }],
      },
      {
        code: "AT-VAT-RED10",
        name: "Austria USt reduced rate 10% (food, rent, books)",
        ratePercent: 10,
        role: "reduced",
        rates: [{ ratePercent: 10, effectiveFrom: "2026-08-01", sourceId: "usp_ust_rates" }],
      },
      {
        code: "AT-VAT-RED13",
        name: "Austria USt reduced rate 13% (2016 Steuerreform band)",
        ratePercent: 13,
        role: "reduced",
        rates: [{ ratePercent: 13, effectiveFrom: "2026-08-01", sourceId: "usp_ust_rates" }],
      },
      {
        code: "AT-VAT-ENCLAVE",
        name: "Jungholz and Mittelberg 19% (German customs union territory)",
        ratePercent: 19,
        rates: [{ ratePercent: 19, effectiveFrom: "2023-01-01", sourceId: "bmf_u30_2023" }],
      },
    ],
  },
};
