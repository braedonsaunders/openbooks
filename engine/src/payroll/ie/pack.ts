/**
 * Ireland payroll country pack — SKELETON, `installable: false`.
 *
 * Declares what Ireland withholds (PAYE income tax, PRSI employee + employer,
 * USC), the Revenue Payroll Notification certificate, the national region and
 * holiday calendar, and named refusals for everything not yet transcribed.
 * No 2026 PAYE/PRSI/USC figures are transcribed here: inventing bands
 * would be silent wrong money, so 2026 is refused by name until the agency
 * publications below are transcribed into `engine/src/payroll/ie/rates.ts`.
 *
 * Sources (checked September 2026, not transcribed):
 * - USC standard rates and thresholds:
 *   https://www.revenue.ie/en/jobs-and-pensions/usc/standard-rates-thresholds.aspx
 *   (€13,000 exemption for 2026; Taxes Consolidation Act 1997 Part 18D)
 * - PRSI classes and rates: Department of Social Protection, PRSI Contribution
 *   Rates and User Guide SW14 (January 2026); gov.ie Operational Guidelines:
 *   PRSI — Contributions and Classes
 * - PAYE/RPN: Revenue Tax and Duty Manual Part 42-04-35A (Employer's Guide to
 *   PAYE); revenue.ie "Basis of taxation"
 * - Remittance timetable (not yet declared as a schedule): TDM Part 42-04-35A —
 *   monthly by the 14th (23rd for ROS e-filers); quarterly or annual when the
 *   employer's yearly PAYE/PRSI/USC/LPT liability is €28,800 or less
 * - Public-holiday entitlement: Organisation of Working Time Act 1997, s.21
 *   (10 public holidays including St Brigid's Day, first Monday in February,
 *   from 2023; part-time entitlement after 40 hours in the previous 5 weeks;
 *   the employer selects the benefit form)
 *
 * `country` is typed `string`, not `PayrollCountry`: the union at packs.ts:190
 * is still `'CA' | 'US'`, so a third pack cannot typecheck its `country`
 * field yet. See packs/proposals/payroll-country-union.md (gb-payroll's
 * propose — do not send a second one). This object registers unchanged once
 * Orchestrate opens the type.
 */
import type {
  PayrollCountryPack,
  PayrollJurisdiction,
  PayrollStatutorySlot,
} from "../packs.ts";
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";
import type { PayrollPackWithholding } from "../withholding-jurisdictions.ts";
import type {
  PayrollEditionScaffold,
  PayrollTaxYearSupport,
} from "../tax-years.ts";
import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollPackFilings } from "../../payroll-filing-registry.ts";

/**
 * The IE pack as it will register once `PayrollCountry` opens: every member
 * except `country` already satisfies `PayrollCountryPack`.
 */
export type IePayrollPack = Omit<PayrollCountryPack, "country"> & {
  country: string;
};

const IE_STATUTORY_SLOTS: readonly PayrollStatutorySlot[] = [
  {
    key: "paye",
    components: [
      // Cumulative PAYE on taxable pay after pension deductions, at the
      // credits and rate band the RPN states — so a pre-tax protected order
      // moves it, exactly like T4127 factor T and Pub 15-T FIT.
      { code: "PAYE", name: "PAYE income tax", systemKey: "paye", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
    ],
  },
  {
    key: "prsi",
    components: [
      // Class A (full-rate employees): employee share on reckonable pay above
      // the weekly threshold, employer share on all reckonable pay. No
      // deduction enters either formula.
      { code: "PRSI", name: "PRSI (employee)", systemKey: "prsi", kind: "deduction", sequence: 120, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "PRSI-ER", name: "PRSI (employer)", systemKey: "prsi", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority" },
    ],
  },
  {
    key: "usc",
    components: [
      // USC on gross pay at the RPN's cutoff points. Rate × pay, no pre-tax
      // deduction in the formula.
      { code: "USC", name: "Universal Social Charge", systemKey: "usc", kind: "deduction", sequence: 130, assessedOn: "earnings", remittance: "tax_authority" },
    ],
  },
];

/**
 * The Revenue Payroll Notification — the live channel, not a W-4/TD1 clone.
 * Revenue issues the RPN per employment (cumulative or week-1/month-1 basis);
 * the pack states what it needs from it. New certificate, so every field is
 * `certificate_rows` storage (the default — no `storage` member).
 */
const IE_RPN: PayrollCertificate = {
  key: "ie_rpn",
  form: "RPN",
  label: "Revenue Payroll Notification",
  scope: { level: "country" },
  purpose: "withholding",
  citation: "Revenue TDM Part 42-04-35A (Employer's Guide to PAYE); "
    + "Revenue TDM Part 18D-00-02 (USC Regulations 2018); revenue.ie PAYE Services",
  summary: "Requested from Revenue for each employment before the first pay in the tax year "
    + "(and whenever credits change). It states the employee's total tax credits, standard rate "
    + "band, USC cutoff points or USC exemption, and the basis — cumulative or week 1/month 1. "
    + "With no RPN the employer must withhold on the emergency basis.",
  storage: "certificate_rows",
  fields: [
    {
      key: "tax_credits_total", label: "Total tax credits (annual)",
      kind: "amount", decimals: 2, min: "0",
      help: "The RPN's total annual tax credits (personal, PAYE, and any others Revenue holds). "
        + "Applied cumulatively from 1 January, or week-1/month-1 when the RPN says so.",
    },
    {
      key: "rate_band_total", label: "Standard rate band (annual)",
      kind: "amount", decimals: 2, min: "0",
      help: "The RPN's standard-rate cutoff: pay within it is taxed at the standard rate, "
        + "pay above it at the higher rate. Unused band carries forward only on the cumulative basis.",
    },
    {
      key: "pay_basis", label: "PAYE basis",
      kind: "choice", default: "cumulative", required: true,
      choices: [
        { value: "cumulative", label: "Cumulative basis", help: "Unused credits and band carry forward from 1 January. Revenue's preferred basis." },
        { value: "week1", label: "Week 1 / Month 1 basis", help: "Each pay period stands alone: no carry-forward of unused credits or band." },
      ],
      help: "The basis the RPN states. Week 1/Month 1 is temporary (e.g. unresolved credits); "
        + "emergency basis, when there is no RPN at all, is not this certificate.",
    },
    {
      key: "usc_cutoff_total", label: "USC cutoff points (annual)",
      kind: "amount", decimals: 2, min: "0",
      help: "The RPN's USC rate cutoff points. Used with the published USC bands to compute "
        + "USC payable or refundable each pay, cumulatively within the year.",
    },
    {
      key: "usc_exempt", label: "Exempt from USC",
      kind: "flag",
      help: "The RPN states the employee is exempt from USC (e.g. income at or below the €13,000 "
        + "annual exemption for 2026, or a qualifying exemption). USC only: PAYE and PRSI still apply.",
    },
    {
      key: "prior_cumulative_pay", label: "Cumulative pay from previous employment (year)",
      kind: "amount", decimals: 2, min: "0",
      help: "Cumulative taxable pay with a previous employer this year, as the RPN reports it. "
        + "Sets the starting position of the cumulative calculation for a mid-year joiner.",
    },
    {
      key: "prior_cumulative_usc", label: "Cumulative USC from previous employment (year)",
      kind: "amount", decimals: 2, min: "0",
      help: "Cumulative USC paid with a previous employer this year, as the RPN reports it.",
    },
  ],
};

const IE_CERTIFICATES: PayrollPackCertificates = {
  country: "IE",
  certificates: [IE_RPN],
};

const IE_WITHHOLDING = {
  country: "IE",
  regions: [
    {
      region: "IE",
      label: "PAYE income tax",
      implemented: false,
      unimplementedReason: "2026 PAYE tax credits and rate bands, PRSI class rates and USC "
        + "bands are not transcribed — see engine/src/payroll/ie/ and packs/ledger/ie-payroll.md",
      // Employment income for work done in Ireland is chargeable whatever the
      // employee's residence (verify against TCA 1997 Part 34 when transcribing).
      taxesNonresidentWages: true,
      // Nobody has established whether Ireland requires an employer to withhold
      // for a resident's out-of-state wages: refused, not guessed — the same
      // posture as the CA pack.
      residentWithholding: "unknown",
      residentWithholdingImplemented: false,
      certificateKey: "ie_rpn",
      // No county or city levies an income tax on wages.
      subRegions: [],
      subRegionConflictRule: "work_only",
      citation: "Revenue TDM Part 42-04-35A (Employer's Guide to PAYE); "
        + "Taxes Consolidation Act 1997",
    },
  ],
} satisfies PayrollPackWithholding;

/**
 * Ireland's ten public holidays. Calendar facts (fixed dates, first/last
 * Mondays, Easter Monday) — stable and cited, not rate transcription. St
 * Brigid's Day (first Monday in February) exists from 2023.
 */
const IE_JURISDICTIONS: readonly PayrollJurisdiction[] = [
  {
    key: "IE",
    name: "Ireland",
    scope: "employment",
    citation: "Organisation of Working Time Act 1997, s.21; S.I. No. 475/1997",
    holidays: [
      { key: "new_years", name: "New Year's Day", rule: { kind: "fixed", month: 1, day: 1 }, observance: "none" },
      { key: "st_brigids", name: "St Brigid's Day", rule: { kind: "nth_weekday", month: 2, weekday: 1, nth: 1 }, observance: "none", from: 2023 },
      { key: "st_patricks", name: "St Patrick's Day", rule: { kind: "fixed", month: 3, day: 17 }, observance: "none" },
      { key: "easter_monday", name: "Easter Monday", rule: { kind: "easter_offset", days: 1 }, observance: "none" },
      { key: "may_day", name: "May Day", rule: { kind: "nth_weekday", month: 5, weekday: 1, nth: 1 }, observance: "none" },
      { key: "june_holiday", name: "June public holiday", rule: { kind: "nth_weekday", month: 6, weekday: 1, nth: 1 }, observance: "none" },
      { key: "august_holiday", name: "August public holiday", rule: { kind: "nth_weekday", month: 8, weekday: 1, nth: 1 }, observance: "none" },
      { key: "october_holiday", name: "October public holiday", rule: { kind: "nth_weekday", month: 10, weekday: 1, nth: -1 }, observance: "none" },
      { key: "christmas", name: "Christmas Day", rule: { kind: "fixed", month: 12, day: 25 }, observance: "none" },
      { key: "st_stephens", name: "St Stephen's Day", rule: { kind: "fixed", month: 12, day: 26 }, observance: "none" },
    ],
    // s.21 as the type can hold it: a normal day's wages, with the published
    // "one-fifth of weekly pay" fallback for employees with no normal day.
    // Two things the type CANNOT hold, recorded here and in the ledger rather
    // than guessed into the declaration: the part-time qualifying test is
    // hours-based (40 hours in the 5 weeks ending the day before the holiday),
    // not days-based; and the employer elects the benefit form per holiday
    // (paid day off, paid day off within a month, extra annual leave, or extra
    // day's pay) rather than following one formula.
    holidayPay: [
      {
        effectiveFrom: null,
        effectiveTo: null,
        rule: {
          citation: "Organisation of Working Time Act 1997, s.21 (benefit form elected by the "
            + "employer; part-time test 40 hours in the 5 weeks before the holiday — see pack notes)",
          basis: {
            kind: "normal_day",
            whenIrregular: { kind: "fixed_divisor", divisor: 5, lookbackWeeks: 1 },
          },
          include: { overtime: false, vacationPay: false, holidayPay: false },
          qualifying: { lastAndFirstScheduledShift: false },
          premium: { multiplier: "1", plusHolidayPay: true },
          lookbackEnds: { kind: "day_before" },
        },
      },
    ],
  },
];

const IE_EDITION_SCAFFOLD: PayrollEditionScaffold = {
  files: [
    {
      path: "engine/src/payroll/ie/rates-{year}.ts",
      purpose: "the year's PAYE credits and bands, PRSI class rates and USC bands — every figure placeheld",
      template: `/** {year} Irish statutory tables — TRANSCRIBE, do not invent.\n * PAYE: Revenue Tax and Duty Manual Part 42-04-35A (Employer's Guide to PAYE).\n * USC: revenue.ie Standard rates and thresholds of USC ({year}).\n * PRSI: Department of Social Protection SW14 Contribution Rates and User Guide ({year}).\n */\nexport const IE_RATES_{year} = { year: {year}, status: "draft" as const };\n`,
    },
    {
      path: "engine/src/payroll/ie/rates-{year}.test.ts",
      purpose: "the failing conformance stub for Revenue's published calculation examples",
      template: `import { test } from "node:test";\nimport assert from "node:assert/strict";\n\ntest("{year} published Revenue examples", () => {\n  assert.ok(\n    false,\n    "paste at least one published {year} Revenue PAYE/USC worked example before paying an IE employee in {year}",\n  );\n});\n`,
    },
  ],
  barrels: [],
  steps: [
    "Fetch the USC standard rates and thresholds page for the year from revenue.ie, "
    + "the Employer's Guide to PAYE (TDM Part 42-04-35A), and the SW14 PRSI Contribution Rates guide.",
    "Replace every placeholder in rates-{year}.ts and record each publication's edition or version.",
    "Cross-verify: the USC band arithmetic against Revenue's worked examples, and the PRSI "
    + "class A thresholds against SW14.",
    "Paste the published examples into the stub test and flip the edition to \"published\".",
    "Run the payroll suite: the {year} stubs must pass and the CA/US goldens must not move.",
  ],
};

const IE_TAX_YEARS: PayrollTaxYearSupport = {
  country: "IE",
  // Nothing transcribed: 2026 PAYE credits/bands, PRSI rates and USC bands
  // are refused by name. The first transcribed edition lands here.
  editions: [],
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/ie/rates.ts",
  scaffold: IE_EDITION_SCAFFOLD,
};

const IE_PACK_RATES: PayrollPackRates = {
  country: "IE",
  // Nothing tenant-entered: PAYE credits, PRSI rates and USC bands are all
  // agency-published constants (transcribed per edition, not per employer),
  // and Ireland has no experience-rated or regional employer levy.
  slots: [],
};

function iePackFilings(): PayrollPackFilings {
  return {
    country: "IE",
    programTypes: [
      { key: "ie_paye", label: "PAYE/PRSI/USC employer registration (Revenue Commissioners)" },
    ],
    // No annual employer return since PAYE Modernisation (January 2019):
    // liability is reported in real time with each payroll submission, the
    // P35 is gone, and employees receive an Employment Detail Summary. An
    // empty year-end list states that; it is not an omission.
    yearEnd: [],
  };
}

export const IE_PAYROLL_PACK: IePayrollPack = {
  country: "IE",
  installable: false,
  // Revenue's engine computes euro; the Irish tax year is the calendar year.
  statutoryCurrency: "EUR",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  // One national region. Supported is EMPTY: the engine withholds for no
  // region until a tax year is transcribed — refused by name, never a fallback.
  regions: {
    label: "region",
    known: ["IE"],
    supported: [],
    unsupportedReason: "PAYE/PRSI/USC withholding for {region} is not implemented by the IE payroll "
      + "pack — no tax year is transcribed (see engine/src/payroll/ie/ and packs/ledger/ie-payroll.md)",
  },
  jurisdictions: IE_JURISDICTIONS,
  statutorySlots: IE_STATUTORY_SLOTS,
  // PAYE/PRSI/USC are remitted to the Collector-General through the
  // org-configured Revenue remittance vendor. No schedule declared yet: the
  // monthly/quarterly timetable (TDM Part 42-04-35A) ships with the tables.
  remittanceVendorSettingsKey: "revenueRemittancePartyId",
  // Tax and USC are deducted at the rates and credits applicable when the
  // payment is made (TDM Part 42-04-35A) — arrears are taxed as paid in the
  // period, not re-spread over the periods they relate to.
  retroactivePayTreatment: "periodic",
  contributoryBases: {
    pensionable: "reckonable earnings for PRSI (employee and employer shares)",
    insurable: "same reckonable pay — Ireland levies no separate insurable-earnings charge",
  },
  // Tax relief on trade-union subscriptions was withdrawn from 2011: dues are
  // post-tax and the engine gives them no treatment.
  employeeUnionDuesTaxTreatment: null,
  filings: iePackFilings,
  statutoryRates: IE_PACK_RATES,
  taxYears: IE_TAX_YEARS,
  certificates: () => IE_CERTIFICATES,
  withholding: () => IE_WITHHOLDING,
  // No statutory engine yet: any calculation attempt is a named refusal, never
  // a number. The transcribing shard replaces this with the cumulative-PAYE /
  // PRSI / USC pass over the RPN answers.
  computeStatutory: async () => {
    throw new Error(
      "the IE payroll pack has no transcribed statutory tables — 2026 PAYE tax credits and rate "
      + "bands, PRSI class rates and USC bands are refused by name. Transcribe the Revenue and "
      + "SW14 publications into engine/src/payroll/ie/rates.ts (see packs/ledger/ie-payroll.md).",
    );
  },
  statutoryEngineLabel: "PAYE",
};
