/**
 * The Singapore payroll pack (2026 transcribed).
 *
 * Singapore's shape is unusual and it is the interesting part: there is NO
 * monthly income-tax withholding. IRAS assesses individuals annually — the
 * employer's duty is to REPORT ("Employers are responsible for reporting the
 * employment income of all individuals who have worked for them"; "The
 * information submitted by employers will be pre-filled in employees'
 * electronic Income Tax Returns", Reporting Employee Earnings (IR8A, App
 * 8A/8B)) — not to withhold. So this pack declares NO income-tax
 * withholding slot and its `withholding` declaration carries no region: an
 * invented monthly tax line would be an invented tax. The one employer-side
 * withholding IRAS names is tax clearance — "you are required to seek tax
 * clearance for him. As an employer, you have the responsibility to file the
 * Form IR21 and withhold all monies due to the employee for tax clearance
 * purpose" (Tax Clearance for Foreign & SPR Employees (IR21)) — a
 * departing-non-citizen event, refused by name until a clearance flow exists.
 *
 * The real monthly lines are CPF (Central Provident Fund) — employee and
 * employer shares from Table 1 by age band against the $8,000 Ordinary Wage
 * ceiling — and the Skills Development Levy (0.25%, $2 floor, $11.25 cap).
 * The interesting axis is the employee's CPF status and age band, which are
 * CERTIFICATE ANSWERS on `sg_cpf_status` (see `./certificates.ts`), not
 * regions: `regions` is the single national region SG.
 *
 * 2026 is transcribed in `./rates.ts` (Table 1 row "55 & below", the OW
 * ceiling, the Board's rounding rule, the SDL rate/floor/cap) and computed
 * in `./cpf.ts`, proven by `./cpf.test.ts` against the Board's own worked
 * examples. Every other year is refused by name; every status and band
 * outside citizen/3rd-year-SPR at 55-and-below is refused by name (see
 * `./certificates.ts`); Additional Wages are refused by name (the AW
 * ceiling is year-dependent and no channel carries YTD OW).
 *
 * REGISTERED and installable: the pack computes CPF end to end for Table 1
 * citizens (and 3rd-year SPRs, same table) at 55 and below, plus SDL, for
 * the single national region — installable even while IR21, the
 * foreign-worker levy, IR8A/AIS population and the OA/SA/MA split are
 * refused by name.
 */
import { PayrollError } from "../error.ts";
import type { PayrollFilingData, PayrollPackFilings } from "../filing-registry.ts";
import type {
  PayrollCountryPack,
  PayrollRemittanceSchedule,
} from "../packs.ts";
import type { PayrollPackWithholding } from "../withholding-jurisdictions.ts";
import { SG_CERTIFICATES } from "./certificates.ts";
import { computeSgStatutory, SG_FACTOR_LABELS } from "./cpf.ts";
import { SG_PACK_RATES, SG_TAX_YEARS } from "./rates.ts";

// ---------------------------------------------------------------------------
// Withholding: there is no monthly income-tax withholding to declare
// ---------------------------------------------------------------------------

/**
 * Singapore levies no monthly income-tax withholding on anyone — resident,
 * nonresident, citizen or foreign — so the SG region entry below prices no
 * income-tax line. `implemented: true` is still the honest value: it is the
 * SAME fact `regions.supported` states (installable-region-coverage.test.ts
 * asserts exactly that equality), namely that the pack determines SG's
 * monthly withholding answer end to end — and that answer is "withhold
 * nothing; report via IR8A/AIS; IR21 only on a departing non-citizen's
 * clearance". An `implemented: false` entry would read as "supported
 * nowhere, installable for nobody" and refuse the whole country at Link 4.
 */
const SG_WITHHOLDING: PayrollPackWithholding = {
  country: "SG",
  regions: [
    {
      region: "SG",
      label: "No monthly income-tax withholding (IRAS reporting only)",
      implemented: true,
      // Singapore withholds nothing from a nonresident's monthly wages
      // either — the only employer withholding IRAS names is IR21 tax
      // clearance on a departing non-citizen's final monies.
      taxesNonresidentWages: false,
      // Nobody has established how Singapore treats a resident's
      // out-of-Singapore wages for withholding: refused, not guessed — the
      // same posture as the IE pack.
      residentWithholding: "unknown",
      residentWithholdingImplemented: false,
      // No municipality or other subnational body levies a wage tax an
      // employer withholds.
      subRegions: [],
      subRegionConflictRule: "both",
      citation:
        "IRAS, Reporting Employee Earnings (IR8A, App 8A/8B); "
        + "IRAS, Tax Clearance for Foreign & SPR Employees (IR21)",
    },
  ],
};

// SG_RATES (tenant slots: none) and SG_TAX_YEARS (2026 published) live in
// `./rates.ts` beside the transcribed Table 1 row the engine reads.

// ---------------------------------------------------------------------------
// Filings: IR8A/AIS reporting and IR21 clearance, both refusing
// ---------------------------------------------------------------------------

/**
 * The employer's CPF Submission Number account, under which monthly CPF and
 * SDL are paid to the CPF Board (which "collects SDL on behalf of" SWDA).
 * The per-month payment itself is a remittance cadence the year-end registry
 * does not model, so the declaration carries the programme and the two
 * named filings; no timetable is declared as a remittance schedule until its
 * due-date rule is transcribed from a Board publication rather than guessed.
 */
function sgPackFilings(): PayrollPackFilings {
  return {
    country: "SG",
    programTypes: [
      { key: "sg_cpf", label: "CPF Submission Number" },
    ],
    yearEnd: [
      {
        key: "ir8a",
        label: "Form IR8A (Auto-Inclusion Scheme)",
        cadence: "annual",
        description:
          "The employer's annual REPORT of each employee's employment income to IRAS "
          + "(\"Employers are responsible for reporting the employment income of all individuals "
          + "who have worked for them\"), pre-filled into the employee's electronic return — "
          + "a report, not a withholding, and not yet populated by this pack.",
        population: async (): Promise<PayrollFilingData> => {
          throw new PayrollError(
            "the SG payroll pack populates no Form IR8A — no IR8A/AIS file builder exists "
            + "(the 2026 CPF/SDL figures it would sit beside are transcribed; the file is not)",
          );
        },
        parseRowId: () => null,
        downloadRefusal:
          "the SG payroll pack produces no Form IR8A file — no IR8A/AIS file builder exists",
        amendment: {
          supported: false,
          refusal:
            "a wrong IR8A is corrected by resubmitting the employment-income record to IRAS — "
            + "no in-product correction file is built",
        },
      },
      {
        key: "ir21",
        label: "Form IR21 (tax clearance)",
        cadence: "separation",
        description:
          "Tax clearance for a departing non-Singapore-Citizen employee: the employer files "
          + "Form IR21 and \"withhold[s] all monies due to the employee for tax clearance purpose\" "
          + "(IRAS, Tax Clearance for Foreign & SPR Employees (IR21)) — the one employer-side "
          + "withholding Singapore names, and not yet built by this pack.",
        population: async (): Promise<PayrollFilingData> => {
          throw new PayrollError(
            "the SG payroll pack seeks no IR21 tax clearance — no IR21 builder exists "
            + "(clearance is an event-driven withholding on a departing non-citizen, not a monthly line)",
          );
        },
        parseRowId: () => null,
        downloadRefusal:
          "the SG payroll pack produces no Form IR21 file — no IR21 builder exists",
        amendment: {
          supported: false,
          refusal:
            "an IR21 is changed by withdrawing or refiling it with IRAS before clearance is issued — "
            + "no in-product correction file is built",
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

/**
 * CPF as the Board publishes it: ONE monthly contribution with an employee
 * share (a `deduction`) and an employer share (an `employer_contribution`),
 * priced from Ordinary Wages against the monthly OW ceiling — not a
 * Canada-shaped federal/provincial split, and not an income tax. The SDL is
 * a separate employer levy on monthly total wages. No other monthly line
 * exists: a monthly income-tax slot would invent a tax IRAS never levies.
 */
export const SG_PAYROLL_PACK: PayrollCountryPack = {
  country: "SG",
  name: "Singapore",
  // Immigration and Checkpoints Authority (ICA): NRIC numbers start with S
  // or T (citizens/PR), FINs with F, G or M (M series from 1 Jan 2022) —
  // each "the prefix, followed by seven digits and a checksum letter". The
  // checksum is NOT enforced (unsourced here). Needed for the IR8A under
  // the Auto-Inclusion Scheme.
  employeeIdentifier: {
    label: "NRIC/FIN",
    pattern: "[STFMG]\\d{7}[A-Z]",
    formatHelp: "a prefix letter (S/T/F/G/M), 7 digits, a letter",
    example: "S1234567D",
    requiredForPayroll: true,
    neededFor: "IR8A (AIS)",
    citation: "ICA: NRIC/FIN is the prefix letter 'followed by seven digits and a checksum letter'",
    numericEntry: false,
  },
  installable: true,
  statutorySlots: [
    {
      key: "cpf",
      components: [
        // Table 1, 55 & below, "> $750" row: "[20% (OW)]*" of OW (max
        // $1,600), rounded DOWN to the dollar. Assessed on OW — no pre-tax
        // deduction enters the CPF formula — so earnings-assessed and
        // computed once, exactly like CPP/EI.
        { code: "CPF_EE", name: "CPF — employee share", systemKey: "cpf_ee", kind: "deduction", sequence: 110, assessedOn: "earnings", remittance: "tax_authority" },
        // "[37% (OW)]*" less the employee share ("Employer's share = Total
        // contribution - Employee's share"), max $2,960 total. Employer-side,
        // earnings-assessed, never re-derived by the protection fixpoint.
        { code: "CPF_ER", name: "CPF — employer share", systemKey: "cpf_er", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority" },
      ],
    },
    {
      key: "sdl",
      components: [
        // "0.25% of the monthly total wages" ($2 floor under $800, $11.25
        // cap over $4,500), collected by the CPF Board on behalf of SWDA —
        // so `tax_authority` alongside CPF, stated here rather than guessed
        // per employee. Employer-side, earnings-assessed.
        { code: "SDL", name: "Skills Development Levy", systemKey: "sdl", kind: "employer_contribution", sequence: 220, assessedOn: "earnings", remittance: "tax_authority" },
      ],
    },
  ],
  statutoryCurrency: "SGD",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: {
    label: "country",
    known: ["SG"],
    // The single national region IS the country: its display name is the
    // pack's own name, stated explicitly so the coverage test holds it.
    regionNames: { SG: "Singapore" },
    // CPF/SDL are national: the engine computes the Singapore lines end to
    // end for 2026, so the country itself is supported and no subnational
    // region is declared. Residency status and age band are certificate
    // answers, not regions.
    supported: ["SG"],
    unsupportedReason:
      "{region} is not a region the SG payroll pack withholds for — Singapore is a single national region",
  },
  // No employment calendar is declared yet: Employment Act leave and holiday
  // pay are not transcribed, and an empty list refuses holiday-pay queries
  // instead of paying a made-up number. `holidayPay: null` would falsely
  // state that no statutory holiday pay exists.
  jurisdictions: [],
  // CPF/SDL remit to the CPF Board under the employer's CPF Submission
  // Number, but payroll settings only store cra/rq today. A key naming a
  // field that does not exist looks wired. Null until Orchestrate adds a
  // CPF Board remittance-party settings field.
  remittanceVendorSettingsKey: null,
  // No remittance schedule is declared: the CPF due-date rule is not
  // transcribed, and the field is optional. A guessed timetable would date
  // real vendor bills.
  remittanceSchedules: [] as readonly PayrollRemittanceSchedule[],
  // Bonuses and backpay are Additional Wages with a year-dependent ceiling
  // ($102,000 − the year's OW) — never annualized into the month's OW. The
  // pack's `nonPeriodic` path, which refuses AW by name until a YTD channel
  // carries the ceiling.
  retroactivePayTreatment: "non_periodic",
  contributoryBases: {
    pensionable: "CPF Ordinary Wages (OW, capped at the monthly OW ceiling)",
    // No employee social-insurance levy runs through the payroll: the SDL
    // prices on monthly total wages, not on a flagged insurable base.
    insurable: "No insurable base — Singapore levies no earnings-related employee insurance through payroll",
  },
  // Union dues buy no CPF treatment: contributions price on OW regardless.
  // Declared null so dues lines carry no treatment.
  employeeUnionDuesTaxTreatment: null,
  // No pre-tax treatment transcribed: every SG statutory component is
  // earnings-assessed, so the pack declares an empty vocabulary rather than
  // an unhonored one.
  deductionTreatments: [],
  filings: sgPackFilings,
  statutoryRates: SG_PACK_RATES,
  taxYears: SG_TAX_YEARS,
  certificates: () => SG_CERTIFICATES,
  withholding: () => SG_WITHHOLDING,
  // The 2026 Table 1 pass. Refuses any other tax year by name, any status or
  // band outside citizen/3rd-year-SPR at 55-and-below by name, any
  // non-periodic (AW) pay by name, and any non-monthly period count by name.
  computeStatutory: computeSgStatutory,
  statutoryEngineLabel: "CPF",
  factorLabels: { ...SG_FACTOR_LABELS },
  // No `emp` facts: the engine reads age band and contribution answers off
  // the certificate rows, never off bare profile keys.
  employeeFacts: [],
};

export { SG_CERTIFICATES, SG_PACK_RATES as SG_RATES, SG_TAX_YEARS, SG_WITHHOLDING };
