/**
 * The Netherlands payroll pack (2026 transcribed).
 *
 * Declares what the Belastingdienst actually levies and files, through the
 * existing `PayrollCountryPack` channels and no other: the combined
 * loonheffing withholding (loonbelasting + premie volksverzekeringen AOW/Anw/Wlz,
 * priced by the Rekenvoorschriften algorithm rather than looked up row by
 * row), the employer-paid premies werknemersverzekeringen (WW/WIA) and the
 * werkgeversheffing Zvw, the loonaangifte programme and the jaaropgaaf, and
 * the one employee-filed certificate (see `./certificates.ts`).
 *
 * 2026 is transcribed in `./rates.ts` (schijventarief, AHK/OUK/AOK/ARK, JGK,
 * AWf/Aof/Zvw, maximumpremieloon) and computed in `./loonheffing.ts`, proven
 * by `./loonheffing.test.ts` against the witte maandtabel. Every other year
 * is refused by name; bonuses are refused by name (the bijzondere tarieven
 * row-selection rule was not obtainable); herleidingssituaties and
 * eindheffing tables are not transcribed (see `rates.ts`).
 *
 * REGISTERED and installable: `PayrollCountry` is now `keyof typeof
 * PAYROLL_COUNTRY_PACKS`. (This was written while the union was closed, when
 * the pack registered nothing and was imported by nothing outside
 * `engine/src/payroll/nl/`; both of those statements are now false.)
 */
import type {
  PayrollCountryPack,
  PayrollRemittanceSchedule,
} from "../packs.ts";
import type { PayrollPackWithholding } from "../withholding-jurisdictions.ts";
import { NL_CERTIFICATES } from "./certificates.ts";
import { nlPackFilings } from "./filings.ts";
import { computeNlStatutory, NL_FACTOR_LABELS } from "./loonheffing.ts";
import { NL_PACK_RATES, NL_TAX_YEARS } from "./rates.ts";

// ---------------------------------------------------------------------------
// Withholding jurisdictions
// ---------------------------------------------------------------------------

/**
 * The Netherlands levies no subnational wage tax: one region, one income-tax
 * withholding (the loonheffing), priced by the national Rekenvoorschriften
 * algorithm for 2026. Loonheffing is national — there are no regions with
 * their own tables to declare. `residentWithholding: "unknown"` because
 * nobody has established the cross-border rule (treaty relief is per
 * employee, not a second withholding).
 */
const NL_WITHHOLDING: PayrollPackWithholding = {
  country: "NL",
  regions: [
    {
      region: "NL",
      label: "Loonbelasting/premie volksverzekeringen",
      implemented: true,
      // Wages earned in the Netherlands are subject to loonheffing whoever
      // earns them; treaty relief is settled per employee, not by skipping
      // the withholding.
      taxesNonresidentWages: true,
      residentWithholding: "unknown",
      residentWithholdingImplemented: false,
      certificateKey: "nl_loonheffingen",
      // No Dutch municipality or province levies a wage tax an employer
      // withholds: municipal taxation is not delegated a payroll tax.
      subRegions: [],
      subRegionConflictRule: "both",
      citation:
        "Belastingdienst, Handboek Loonheffingen 2026; witte loonbelastingtabellen 2026 "
        + "(loonbelasting/premie volksverzekeringen), uitgave januari 2026",
    },
  ],
};

// NL_RATES (tenant slots: none) and NL_TAX_YEARS (2026 published) live in
// `./rates.ts` beside the transcribed tables the engine reads.

// ---------------------------------------------------------------------------
// Filings: the loonaangifte programme and the jaaropgaaf
// ---------------------------------------------------------------------------

/**
 * The employer's payroll tax number (loonheffingennummer) account, under
 * which every loonaangifte is filed with the Belastingdienst per
 * aangiftetijdvak (maand or vier weken). The per-period return itself is a
 * filing cadence the year-end registry does not model, so the declaration
 * carries the programme and the year-end slip; the timetable is not declared
 * as a remittance schedule until its due-date rule is transcribed from the
 * agency publication rather than guessed.
 */
// The filing declaration lives beside the builder that populates it
// (`./filings.ts`), so the year-end surface enumerates the jaaropgaaf
// wherever the pack is declared. The per-period loonaangifte return itself is
// a filing cadence the year-end registry does not model, so the declaration
// carries the programme and the year-end slip; the timetable is not declared
// as a remittance schedule until its due-date rule is transcribed from the
// agency publication rather than guessed.

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

/**
 * The loonheffing as the Belastingdienst publishes it: ONE combined
 * withholding of loonbelasting (wage tax) and premie volksverzekeringen
 * (AOW, Anw, Wlz), looked up in a single witte tabel — not a Canada-shaped
 * federal/provincial split. The employee-paid SV premiums the Canadian split
 * might suggest do not exist: beyond the loonheffing the employee pays only
 * sectoral pension contributions (per-employer, no statutory tables) and the
 * nominal Zvw premium directly to their insurer, neither of which is a
 * statutory slot.
 */
export const NL_PAYROLL_PACK: Omit<PayrollCountryPack, "country"> & { country: "NL" } = {
  country: "NL",
  name: "Netherlands",
  // Belastingdienst / Rijksoverheid: the burgerservicenummer (BSN) is the
  // 9-digit personal number for contact with the government, issued on BRP
  // registration. Length and digit shape only — the elfproef (11-test) is
  // real but unsourced here, so it is NOT enforced. Needed for the
  // loonaangifte (wage tax return).
  employeeIdentifier: {
    label: "burgerservicenummer (BSN)",
    pattern: "\\d{9}",
    formatHelp: "9 digits",
    example: "111222333",
    requiredForPayroll: true,
    neededFor: "loonaangifte",
    citation: "Belastingdienst: the BSN is the 9-digit personal number for contact with the government (BRP)",
    numericEntry: true,
  },
  installable: true,
  statutorySlots: [
    {
      key: "loonheffing",
      components: [
        // The witte tabel look-up: loonbelasting and premie
        // volksverzekeringen (AOW/Anw/Wlz) withheld as ONE amount. Assessed
        // on taxable wage — employee pension contributions reduce the
        // grondslag — so a pre-tax protected order moves it and the fixpoint
        // re-derives it, exactly like T4127 factor T.
        { code: "LH", name: "Loonbelasting/premie volksverzekeringen", systemKey: "loonheffing", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
      ],
    },
    {
      key: "werknemersverzekeringen",
      components: [
        // Employer-paid, assessed on the SV-loon (premieloon, capped at the
        // maximumpremieloon) and settled through the loonaangifte with the
        // Belastingdienst (administered by UWV): WW via the AWf (hoog/laag by
        // declared contract type, 2026: 2,74%/7,74%), WIA via the Aof
        // basispremie (declared employer size, 2026: 6,27%/7,63%) together
        // with the differentiated Whk beschikking (one percentage, declared),
        // and ZW. No fixed ZW percentage is published (Tarieven Tabel 9
        // carries no ZW row; ZW-flex runs inside the Whk beschikking), so the
        // ZW component posts nothing — see computeNlStatutory.
        { code: "WW", name: "Werkloosheidswet (AWf)", systemKey: "ww", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority" },
        { code: "WIA", name: "Arbeidsongeschiktheid (Aof + Whk)", systemKey: "wia", kind: "employer_contribution", sequence: 211, assessedOn: "earnings", remittance: "tax_authority" },
        { code: "ZW", name: "Ziektewet", systemKey: "zw", kind: "employer_contribution", sequence: 212, assessedOn: "earnings", remittance: "tax_authority" },
      ],
    },
    {
      key: "zvw",
      components: [
        // The employer-side Zorgverzekeringswet contribution
        // (werkgeversheffing Zvw), assessed on the SV-loon and settled
        // through the loonaangifte. The employee's nominal Zvw premium is
        // paid directly to their insurer and is deliberately NOT a slot.
        { code: "ZVW", name: "Werkgeversheffing Zorgverzekeringswet", systemKey: "zvw", kind: "employer_contribution", sequence: 230, assessedOn: "earnings", remittance: "tax_authority" },
      ],
    },
  ],
  statutoryCurrency: "EUR",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: {
    label: "country",
    known: ["NL"],
    // The single national region IS the country: its display name is the
    // pack's own name, stated explicitly so the coverage test holds it.
    regionNames: { NL: "Netherlands" },
    // Loonheffing is national: the engine computes the one Dutch withholding
    // end to end for 2026, so the country itself is supported and no
    // subnational region is declared.
    supported: ["NL"],
    unsupportedReason:
      "income tax withholding for {region} is not implemented by the NL payroll pack",
  },
  // No employment calendar is declared yet: the Dutch statutory facts (BW
  // 7:634 minimum vacation, Wet minimumloon art. 15 vakantiebijslag) are not
  // transcribed, and an empty list refuses holiday-pay queries instead of
  // paying a made-up number. `holidayPay: null` would falsely state that no
  // statutory holiday pay exists.
  jurisdictions: [],
  // Loonheffing remits to the Belastingdienst under the employer's
  // loonheffingennummer, but payroll settings only store cra/rq today.
  // A key naming a field that does not exist looks wired. Null until
  // Orchestrate adds a Belastingdienst remittance-party settings field.
  remittanceVendorSettingsKey: null,
  remittanceRegionalCalendars: {},
  // No remittance schedule is declared: the aangifte/betaling due-date rule
  // is not transcribed, and the field is optional. A guessed timetable would
  // date real vendor bills.
  remittanceSchedules: [] as readonly PayrollRemittanceSchedule[],
  // Nabetalingen and other bijzondere beloningen are taxed through the tabel
  // voor bijzondere beloningen, not annualized as period income (Handboek
  // Loonheffingen 2026, paragraaf 9.3.6) — the pack's `nonPeriodic` path.
  retroactivePayTreatment: "non_periodic",
  contributoryBases: {
    // No statutory state pension runs through the payroll: pension is
    // sectoral, per employer, with no Belastingdienst tables.
    pensionable: "Pensioengevend loon (sectoral pension scheme, per employer — no statutory tables)",
    insurable: "Premieloon werknemersverzekeringen (WW/WIA/ZW, SV-loon)",
  },
  // Employee-paid vakbondscontributie has no loonheffing deduction: only an
  // employer reimbursement (e.g. via the werkkostenregeling) carries tax
  // treatment, and that is employer-side. Declared null so dues lines carry
  // no treatment.
  employeeUnionDuesTaxTreatment: null,
  // No pre-tax treatment transcribed: the engine prices loonheffing off
  // gross, so the pack declares an empty vocabulary rather than an
  // unhonored one.
  deductionTreatments: [],
  filings: nlPackFilings,
  statutoryRates: NL_PACK_RATES,
  taxYears: NL_TAX_YEARS,
  certificates: () => NL_CERTIFICATES,
  withholding: () => NL_WITHHOLDING,
  // Phase 9 — the 2026 Rekenvoorschriften pass. Refuses any other tax year
  // by name, and refuses bonuses by name (bijzondere tarieven).
  computeStatutory: computeNlStatutory,
  statutoryEngineLabel: "Loonbelastingtabellen",
  factorLabels: { ...NL_FACTOR_LABELS },
  // No `emp` facts: the engine reads the loonheffing answers off the
  // certificate rows, never off bare profile keys.
  employeeFacts: [],
  employerFacts: [],
};

export { NL_CERTIFICATES, NL_PACK_RATES as NL_RATES, NL_TAX_YEARS, NL_WITHHOLDING };
