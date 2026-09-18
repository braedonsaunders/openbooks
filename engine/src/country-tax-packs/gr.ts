import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const GR_FPA_F2_2024: TaxReturnPack = {
  code: "GR_FPA_F2",
  name: "Δήλωση ΦΠΑ (Φ2) — 050 ΦΠΑ έκδοση 2024",
  country: "GR",
  jurisdiction: { code: "GR", name: "Greece — ΦΠΑ territory", country: "GR", level: "country", taxType: "vat" },
  defaultFrequency: "quarterly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.aade.gr/myaade",
  watermark: "Working copy — confirm the filing period in myAADE, then file through the AADE portal",
  boxes: [
    { lineCode: "301", label: "Κωδ. 301 — φορολογητέες εκροές 13% (λοιπή Ελλάδα)", sign: 1, sequence: 10 },
    { lineCode: "331", label: "Κωδ. 331 — φόρος εκροών 13%", sign: -1, sequence: 20 },
    { lineCode: "302", label: "Κωδ. 302 — φορολογητέες εκροές 6% (λοιπή Ελλάδα)", sign: 1, sequence: 30 },
    { lineCode: "332", label: "Κωδ. 332 — φόρος εκροών 6%", sign: -1, sequence: 40 },
    { lineCode: "303", label: "Κωδ. 303 — φορολογητέες εκροές 24% (λοιπή Ελλάδα)", sign: 1, sequence: 50 },
    { lineCode: "333", label: "Κωδ. 333 — φόρος εκροών 24%", sign: -1, sequence: 60 },
    { lineCode: "308", label: "Κωδ. 308 — φορολογητέες εκροές 4% (υπέρβαση εμποδίων ΑμεΑ)", sign: 1, sequence: 70 },
    { lineCode: "338", label: "Κωδ. 338 — φόρος εκροών 4%", sign: -1, sequence: 80 },
    { lineCode: "304", label: "Κωδ. 304 — φορολογητέες εκροές 9% (νησιά Αιγαίου)", sign: 1, sequence: 90 },
    { lineCode: "334", label: "Κωδ. 334 — φόρος εκροών 9% (νησιά Αιγαίου)", sign: -1, sequence: 100 },
    { lineCode: "305", label: "Κωδ. 305 — φορολογητέες εκροές 4% (νησιά Αιγαίου)", sign: 1, sequence: 110 },
    { lineCode: "335", label: "Κωδ. 335 — φόρος εκροών 4% (νησιά Αιγαίου)", sign: -1, sequence: 120 },
    { lineCode: "306", label: "Κωδ. 306 — φορολογητέες εκροές 17% (νησιά Αιγαίου)", sign: 1, sequence: 130 },
    { lineCode: "336", label: "Κωδ. 336 — φόρος εκροών 17% (νησιά Αιγαίου)", sign: -1, sequence: 140 },
    { lineCode: "309", label: "Κωδ. 309 — φορολογητέες εκροές 3% νησιών (υπέρβαση εμποδίων ΑμεΑ)", sign: 1, sequence: 150 },
    { lineCode: "339", label: "Κωδ. 339 — φόρος εκροών 3% νησιών", sign: -1, sequence: 160 },
    { lineCode: "307", label: "Κωδ. 307 — σύνολο φορολογητέων εκροών", sign: 1, sequence: 170 },
    { lineCode: "337", label: "Κωδ. 337 — σύνολο φόρου εκροών", sign: -1, sequence: 180 },
    { lineCode: "367", label: "Κωδ. 367 — σύνολο φορολογητέων εισροών", sign: 1, sequence: 190 },
    { lineCode: "387", label: "Κωδ. 387 — σύνολο φόρου εισροών", sign: 1, sequence: 200 },
    { lineCode: "430", label: "Κωδ. 430 — υπόλοιπο φόρου εισροών", sign: 1, sequence: 210 },
    { lineCode: "470", label: "Κωδ. 470 — πιστωτικό υπόλοιπο", sign: 1, sequence: 220 },
    { lineCode: "480", label: "Κωδ. 480 — χρεωστικό υπόλοιπο", sign: 1, sequence: 230 },
    { lineCode: "511", label: "Κωδ. 511 — ποσό προς καταβολή", sign: 1, sequence: 240 },
    { lineCode: "502", label: "Κωδ. 502 — ποσό για έκπτωση", sign: 1, sequence: 250 },
    { lineCode: "503", label: "Κωδ. 503 — αιτούμενο ποσό για επιστροφή", sign: 1, sequence: 260 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 270, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 280, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Greece ΦΠΑ localization.
 *
 * Currency is EUR; the pack carries no currency field. myDATA e-books are
 * out of scope: named here, declared nowhere.
 *
 * Filing: quarterly is the default (single-entry books and traders with no
 * books file by quarter — E.2030 covers the 3rd quarter of 2024 for them).
 * Monthly filing for double-entry books (E.2030 covers July 2024 for them)
 * is an unmodelled election, not a second return.
 *
 * Island relief: the Aegean islands file the SAME Φ2 with different
 * κωδικοί — table B section I carries mainland rows 301–303/308 while
 * section II carries island rows 304–306/309 — so the island rates are rate
 * bands on this return and jurisdictions stays empty. The 30% cut is in
 * force: the Economy Ministry announced on 10.9.2025 that 19 border islands
 * carry it from 1.1.2026 (24%→17%, 13%→9%, all goods and services, no
 * published end date), and the island 4% band is the 30% cut of the 6%
 * band printed as row 305 on the Φ2 itself. The pre-2026 five-island
 * regime (Leros, Lesbos, Kos, Samos, Chios) and its extensions are
 * explicitly unmodelled: no fetched authority source attests their scope
 * or dates, so island bands start at the attestable 2026-01-01 expansion.
 *
 * Histories are left-truncated at the 2024 form's applicability
 * (transactions from 1.7.2024): the 23%→24% change of 1.6.2016 and all
 * earlier bands are a named refusal — www.aade.gr and aade.gr answer this
 * sandbox with Akamai 403, so neither AADE nor the Gazette could attest an
 * origin date from here.
 *
 * Box table source: the AADE Φ2 form «050 - Φ.Π.Α. ΕΚΔΟΣΗ 2024» issued
 * under decision A.1058/2024 as mirrored by logistis.gr — it qualifies as
 * the authority's own document mirrored elsewhere because every 2024
 * addition on it (rows 308/309, codes 313–315 and 912, abolished code 400)
 * cross-checks against AADE circular E.2030 fetched from Diavgeia.
 */
export const GREECE_TAX_PACK: CountryTaxPackDefinition = {
  code: "GR_INDIRECT_TAX",
  version: "2026.08.01",
  country: "GR",
  name: "Greece",
  countryTaxType: "vat",
  parentReturnPackCode: "GR_FPA_F2",
  completeness: {
    jurisdictions: "not_applicable",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "partial",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "gr_f2_applicability_e2030",
      title: "AADE circular E.2030 via Diavgeia — completion instructions for form 050 ΦΠΑ έκδοση 2024 – Φ2 TAXIS, in force for transactions from 1.7.2024; monthly filing for double-entry books, quarterly otherwise (applicability, not origin)",
      url: "https://diavgeia.gov.gr/doc/942Ρ46ΜΠ3Ζ-0ΞΗ",
      asOf: "2026-09-18",
    },
    {
      id: "gr_f2_form_2024_mirror",
      title: "AADE Φ2 form 050 ΦΠΑ ΕΚΔΟΣΗ 2024 under decision A.1058/2024 mirrored by logistis.gr — authority's own form, every 2024 box change cross-checked against E.2030; used because www.aade.gr refuses this sandbox",
      url: "https://www.logistis.gr/files/06-EGKYKLIOI-Apofaseis_2024/A_1058/Entypo-F2_FPA-2024.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "gr_minfin_islands_202509",
      title: "Economy Ministry 10.9.2025 — 30% VAT cut on 19 border islands from 1.1.2026 (24% to 17%, 13% to 9%), all goods and services, no published end date",
      url: "https://minfin.gov.gr/stirixi-sta-akritika-nisia-me-meiosi-fpa-kai-enfia/",
      asOf: "2026-09-18",
    },
    {
      id: "gr_minfin_superreduced_2024",
      title: "Economy Ministry — new 4% super-reduced rate for disability-access building works, 3% on islands where the 30%-reduced rate applies (applicability, not origin)",
      url: "https://minfin.gov.gr/meionetai-o-fpa-gia-agrotika-michanimata-kai-ergasies-arsis-ebodion-gia-prosvasi-se-ktiria-dimosiou-symferontos/",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [GR_FPA_F2_2024],
  returnPackTaxCodes: {
    GR_FPA_F2: [
      {
        code: "GR-VAT-STD",
        name: "Greece standard VAT 24%",
        ratePercent: 24,
        role: "standard",
        rates: [{ ratePercent: 24, effectiveFrom: "2024-07-01", sourceId: "gr_f2_applicability_e2030" }],
      },
      {
        code: "GR-VAT-RED13",
        name: "Greece reduced VAT 13%",
        ratePercent: 13,
        role: "reduced",
        rates: [{ ratePercent: 13, effectiveFrom: "2024-07-01", sourceId: "gr_f2_applicability_e2030" }],
      },
      {
        code: "GR-VAT-RED6",
        name: "Greece reduced VAT 6% — books, medicines",
        ratePercent: 6,
        role: "reduced",
        rates: [{ ratePercent: 6, effectiveFrom: "2024-07-01", sourceId: "gr_f2_applicability_e2030" }],
      },
      {
        code: "GR-VAT-RED4",
        name: "Greece super-reduced VAT 4% — disability-access building works",
        ratePercent: 4,
        role: "reduced",
        rates: [{ ratePercent: 4, effectiveFrom: "2024-07-01", sourceId: "gr_minfin_superreduced_2024" }],
      },
      {
        code: "GR-VAT-ISL17",
        name: "Greece Aegean-islands VAT 17% — island band of the 24% rate",
        ratePercent: 17,
        role: "reduced",
        rates: [{ ratePercent: 17, effectiveFrom: "2026-01-01", sourceId: "gr_minfin_islands_202509" }],
      },
      {
        code: "GR-VAT-ISL9",
        name: "Greece Aegean-islands VAT 9% — island band of the 13% rate",
        ratePercent: 9,
        role: "reduced",
        rates: [{ ratePercent: 9, effectiveFrom: "2026-01-01", sourceId: "gr_minfin_islands_202509" }],
      },
      {
        code: "GR-VAT-ISL4",
        name: "Greece Aegean-islands VAT 4% — island band of the 6% rate",
        ratePercent: 4,
        role: "reduced",
        rates: [{ ratePercent: 4, effectiveFrom: "2026-01-01", sourceId: "gr_minfin_islands_202509" }],
      },
      {
        code: "GR-VAT-ISL3",
        name: "Greece Aegean-islands VAT 3% — island band of the 4% rate",
        ratePercent: 3,
        role: "reduced",
        rates: [{ ratePercent: 3, effectiveFrom: "2026-01-01", sourceId: "gr_minfin_superreduced_2024" }],
      },
    ],
  },
};
