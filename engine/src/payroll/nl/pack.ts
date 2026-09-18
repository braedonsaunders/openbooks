/**
 * The Netherlands payroll pack (skeleton).
 *
 * Declares what the Belastingdienst actually levies and files, through the
 * existing `PayrollCountryPack` channels and no other: the combined
 * loonheffing withholding (loonbelasting + premie volksverzekeringen AOW/Anw/Wlz,
 * looked up in the witte loonbelastingtabellen), the employer-paid premies
 * werknemersverzekeringen (WW/WIA/ZW) and the werkgeversheffing Zvw, the
 * loonaangifte programme and the jaaropgaaf, and the one employee-filed
 * certificate (see `./certificates.ts`).
 *
 * SKELETON: `installable: false` and no tax year is transcribed. The 2026
 * witte tabellen (maand/vierweken/week/dag, standaard) and the 2026 tabellen
 * voor bijzondere beloningen are published by the Belastingdienst but no
 * band is transcribed here — the pack refuses every year by name through
 * `NL_TAX_YEARS` (empty editions) and `computeNlStatutory` throws before it
 * can compute. Transcribing 2026 is the follow-up commit, one sourced table
 * at a time.
 *
 * Registration is blocked upstream: `PayrollCountry` is still `"CA" | "US"`
 * (`engine/src/payroll/packs.ts`), so this object is typed as the pack with
 * only `country` widened — it registers unchanged once Orchestrate opens the
 * type (see `packs/proposals/payroll-country-union.md`). This module is
 * imported by nothing outside `engine/src/payroll/nl/` and registers nothing
 * in any generic registry, so the CA/US goldens cannot move.
 */
import { PayrollError } from "../../payroll-error.ts";
import type { PayrollFilingData, PayrollPackFilings } from "../../payroll-filing-registry.ts";
import type {
  PayrollCountryPack,
  PayrollRemittanceSchedule,
} from "../packs.ts";
import type { PayrollPackWithholding } from "../withholding-jurisdictions.ts";
import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollTaxYearSupport } from "../tax-years.ts";
import { NL_CERTIFICATES } from "./certificates.ts";

// ---------------------------------------------------------------------------
// Withholding jurisdictions
// ---------------------------------------------------------------------------

/**
 * The Netherlands levies no subnational wage tax: one region, one income-tax
 * withholding (the loonheffing), looked up in the national witte tabellen.
 * `implemented: false` with the reason naming the missing transcription —
 * the engine computes nothing until the tables land, and
 * `residentWithholding: "unknown"` because nobody has established the
 * cross-border rule (treaty relief is per employee, not a second withholding).
 */
const NL_WITHHOLDING: PayrollPackWithholding = {
  country: "NL",
  regions: [
    {
      region: "NL",
      label: "Loonbelasting/premie volksverzekeringen",
      implemented: false,
      unimplementedReason:
        "the 2026 witte loonbelastingtabellen (loonbelasting/premie volksverzekeringen) are not "
        + "transcribed into engine/src/payroll/nl/ — see NL_TAX_YEARS",
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

// ---------------------------------------------------------------------------
// Tenant-entered statutory rates
// ---------------------------------------------------------------------------

/**
 * No tenant-entered rate slots are declared yet. The employer-paid premiums
 * whose percentages the Belastingdienst publishes yearly (AWf hoog/laag by
 * contract type, Aof, Whk/WGA, ZW, werkgeversheffing Zvw) will need slots or
 * edition constants when the tables are transcribed — the Whk percentages in
 * particular are set per employer by beschikking — but declaring a slot now,
 * before the transcription fixes the engine's inputs, would be a shape
 * without a reader.
 */
const NL_RATES: PayrollPackRates = {
  country: "NL",
  slots: [],
};

// ---------------------------------------------------------------------------
// Tax years: every year refused by name until transcribed
// ---------------------------------------------------------------------------

const NL_TAX_YEARS: PayrollTaxYearSupport = {
  country: "NL",
  // No published edition is carried: 2026 (and every earlier year) is
  // refused as "missing" by payrollTaxYearProblem, naming the year and this
  // module. The publications to transcribe are the witte loonbelastingtabellen
  // 2026, the 2026 tabellen voor bijzondere beloningen (Handboek §9.3.6), and
  // the "Tarieven, bedragen en percentages loonheffingen" newsletter.
  editions: [],
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/nl/rates.ts",
  scaffold: {
    files: [],
    barrels: [],
    steps: [
      "Transcribe the 2026 witte loonbelastingtabellen (standaard, Nederland) into engine/src/payroll/nl/rates.ts from download.belastingdienst.nl.",
      "Transcribe the 2026 tabellen voor bijzondere beloningen (Handboek Loonheffingen 2026, paragraaf 9.3.6).",
      "Transcribe the employer premiums from 'Tarieven, bedragen en percentages loonheffingen vanaf 1 januari 2026'.",
      "Add a published 2026 edition to NL_TAX_YEARS.editions with the edition label and citation, plus conformance goldens.",
    ],
  },
};

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
function nlPackFilings(): PayrollPackFilings {
  return {
    country: "NL",
    programTypes: [
      { key: "nl_loonheffingen", label: "Loonheffingen (payroll tax number)" },
    ],
    yearEnd: [
      {
        key: "jaaropgaaf",
        label: "Jaaropgaaf",
        cadence: "annual",
        description:
          "The annual statement the employer issues to the employee (Handboek Loonheffingen 2026, "
          + "hoofdstuk 12): wages, withheld loonbelasting/premie volksverzekeringen, whether the "
          + "loonheffingskorting was applied, and the SV wage base.",
        population: async (): Promise<PayrollFilingData> => {
          throw new PayrollError(
            "the NL payroll pack populates no jaaropgaaf — its 2026 statutory tables are not "
            + "transcribed (see NL_TAX_YEARS)",
          );
        },
        parseRowId: () => null,
        downloadRefusal:
          "the NL payroll pack produces no jaaropgaaf file — its 2026 statutory tables are not transcribed",
        amendment: {
          supported: false,
          refusal:
            "a wrong jaaropgaaf is corrected by filing a corrected loonaangifte (correctiebericht) "
            + "with the Belastingdienst and issuing a corrected statement — no in-product correction "
            + "file is built",
        },
      },
    ],
  };
}

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
  installable: false,
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
        // Employer-paid, assessed on the SV-loon (premieloon) and settled
        // through the loonaangifte with the Belastingdienst (administered by
        // UWV): WW via the AWf (hoog/laag by contract type), WIA via the
        // Werkhervattingskas, and ZW. No rates are carried — see NL_RATES.
        { code: "WW", name: "Werkloosheidswet (AWf)", systemKey: "ww", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority" },
        { code: "WIA", name: "Arbeidsongeschiktheid (WGA/IVA)", systemKey: "wia", kind: "employer_contribution", sequence: 211, assessedOn: "earnings", remittance: "tax_authority" },
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
    // The engine computes no Dutch withholding until the witte tabellen are
    // transcribed: an empty supported list refuses NL by name instead of
    // approximating it with another country's tables.
    supported: [],
    unsupportedReason:
      "income tax withholding for {region} is not implemented by the NL payroll pack — the 2026 "
      + "witte loonbelastingtabellen are not transcribed (see NL_TAX_YEARS in engine/src/payroll/nl/)",
  },
  // No employment calendar is declared yet: the Dutch statutory facts (BW
  // 7:634 minimum vacation, Wet minimumloon art. 15 vakantiebijslag) are not
  // transcribed, and an empty list refuses holiday-pay queries instead of
  // paying a made-up number. `holidayPay: null` would falsely state that no
  // statutory holiday pay exists.
  jurisdictions: [],
  // All loonheffing is remitted to the Belastingdienst under the employer's
  // loonheffingennummer, per aangiftetijdvak (maand or vier weken).
  remittanceVendorSettingsKey: "belastingdienstRemittancePartyId",
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
  filings: nlPackFilings,
  statutoryRates: NL_RATES,
  taxYears: NL_TAX_YEARS,
  certificates: () => NL_CERTIFICATES,
  withholding: () => NL_WITHHOLDING,
  // Phase 9 — refuses until a tax year is transcribed. Required on the type;
  // unreachable while installable is false.
  computeStatutory: async (): Promise<Record<string, string>> => {
    throw new PayrollError(
      "the NL payroll pack computes nothing — no tax year is transcribed (the 2026 witte "
      + "loonbelastingtabellen are not in engine/src/payroll/nl/; see NL_TAX_YEARS)",
    );
  },
  statutoryEngineLabel: "Loonbelastingtabellen",
};

export { NL_CERTIFICATES, NL_RATES, NL_TAX_YEARS, NL_WITHHOLDING };
