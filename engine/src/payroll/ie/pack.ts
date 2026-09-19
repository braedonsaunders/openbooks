/**
 * Ireland payroll country pack — 2026 TRANSCRIBED, `installable: true`.
 *
 * Computes 2026 PAYE (cumulative and week-1/month-1), Class A PRSI
 * (employee + employer, week-one) and standard USC (cumulative and week-1)
 * from the agency publications quoted in `rates.ts`, through the pure
 * engine in `compute.ts`, proven by the conformance goldens in
 * `conformance.test.ts` and the boundary sweep in `sweep.test.ts`.
 *
 * Named refusals that remain: pay dates outside calendar 2026; no RPN
 * (emergency basis); reduced USC (70+/medical-card); monthly pay in the
 * PRSI AX band (no published monthly credit); sub-€38 weekly pay
 * (Class J); four-weekly PRSI (no published bands); frequencies outside
 * weekly/fortnightly/four-weekly/monthly; week 53 / fortnight 27.
 *
 * Remittance timetable (not yet declared as a schedule): TDM Part 42-04-35A —
 * monthly by the 14th (23rd for ROS e-filers); quarterly when the employer's
 * yearly PAYE/PRSI/USC/LPT liability is €28,800 or less. Ships separately;
 * the pack remits everything through the Revenue vendor.
 *
 * Public-holiday entitlement: Organisation of Working Time Act 1997, s.21
 * (10 public holidays including St Brigid's Day, first Monday in February,
 * from 2023; part-time entitlement after 40 hours in the previous 5 weeks;
 * the employer selects the benefit form).
 *
 * REGISTERED: `PayrollCountry` is now `keyof typeof PAYROLL_COUNTRY_PACKS`, so
 * this pack is in the registry and installable. (It was written while the
 * union was closed, with `country` typed `string` to get past it.)
 */
import { sql } from "drizzle-orm";
import { add, neg } from "../../money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import {
  type PayrollCountryPack,
  type PayrollJurisdiction,
  type PayrollStatutorySlot,
} from "../packs.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { calculateIeStatutory, ieWeekNumber } from "./compute.ts";
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
    // Withheld PAYE/PRSI/USC all remit to the Collector-General in the one
    // payment, so every slot rides the chart's payroll-deductions account:
    // the pack names the ROLE and the chart resolves it, never a number.
    liabilityAccountRole: "payrollDeductions",
    components: [
      // Cumulative PAYE on taxable pay after pension deductions, at the
      // credits and rate band the RPN states — so a pre-tax protected order
      // moves it, exactly like T4127 factor T and Pub 15-T FIT.
      //
      // The code and system key are Ireland-qualified (IEPAYE/ie_paye), not
      // the bare PAYE/paye the GB pack seeds: pay_components is unique on
      // (org, code) and (org, system key, kind), so a shared identity means
      // the second pack installed never seeds its row and its runs push
      // onto the first pack's component — Irish PAYE posting to the GB
      // row's liability account. The CA pack's QCTAX precedent, same shape.
      { code: "IEPAYE", name: "PAYE income tax", systemKey: "ie_paye", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
    ],
  },
  {
    key: "prsi",
    liabilityAccountRole: "payrollDeductions",
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
    liabilityAccountRole: "payrollDeductions",
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
    {
      key: "prior_cumulative_tax", label: "Cumulative Income Tax from previous employment (year)",
      kind: "amount", decimals: 2, min: "0",
      help: "Cumulative Income Tax paid with a previous employer this year, as the RPN reports it. "
        + "The RPN shows previous income along with the tax and USC paid on that employment; "
        + "all three set the cumulative starting position for a mid-year joiner.",
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
      implemented: true,
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
  editions: [
    {
      year: 2026,
      label: "2026 PAYE/USC tables and PRSI Class A rates (January edition)",
      effectiveFrom: "2026-01-01",
      citation: "Revenue Tax rates, bands and reliefs chart (published 01 January 2026); "
        + "Revenue USC standard rates and thresholds (published 01 January 2026); "
        + "DSP SW14 January 2026; DSP Advance Notice 2026",
      status: "published",
    },
    {
      year: 2026,
      label: "2026 PRSI Roadmap step (October edition: employee 4.35%, employer 9.15%/11.40%)",
      effectiveFrom: "2026-10-01",
      citation: "DSP Advance Notice effective from 1 October 2026 (PRSI Roadmap, not a Budget measure); "
        + "DSP PRSI Class A Rates (updated 10 June 2026)",
      status: "published",
    },
  ],
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

export type IeYtdRow = {
  tax: string;
  usc: string;
  taxbase: string;
  gross: string;
};

/**
 * Year-to-date statutory inputs from committed payroll. Calculated runs are
 * drafts and may be abandoned; counting them would let unpaid figures
 * consume credits and bands in a later run. There are no IE columns on
 * payroll_opening_balances (no migration in this change), so mid-year
 * joiners enter through the RPN's prior-cumulative fields — which is the
 * actual Irish mechanism (the RPN "shows their previous income along with
 * the tax and USC paid on that employment").
 */
export async function ieEmployeeYtd(
  ctx: Pick<
    PayrollStatutoryComputeContext,
    "tx" | "orgId" | "employeePartyId" | "taxYear" | "documentId"
  >,
): Promise<IeYtdRow> {
  const { tx, orgId, employeePartyId, taxYear, documentId } = ctx;
  const r = await tx.execute<IeYtdRow>(sql`
    select
      coalesce(sum((s.factors->>'IE_PAYE')::numeric), 0) as tax,
      coalesce(sum((s.factors->>'IE_USC')::numeric), 0) as usc,
      coalesce(sum((s.factors->>'IE_TAXBASE')::numeric), 0) as taxbase,
      coalesce(sum(s.pensionable_earnings), 0) as gross
    from pay_stubs s
    join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
    join documents d on d.id = r.document_id and d.org_id = r.org_id
    where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
      and s.tax_year = ${taxYear} and s.pay_run_document_id <> ${documentId}
      and r.run_status = 'committed'
      and d.status <> 'voided'
  `);
  return r.rows[0]!;
}

function elapsedPeriodsForPayDate(payDate: string, periodsPerYear: number): number {
  if (periodsPerYear === 52) {
    const week = ieWeekNumber(payDate);
    if (week > 52) {
      throw new PayrollPackError(
        "IE payroll: week 53 needs the TDM week-53 / fortnight-27 rules — refused by name",
      );
    }
    return week;
  }
  if (periodsPerYear === 26) {
    const fortnight = Math.ceil(ieWeekNumber(payDate) / 2);
    if (fortnight > 26) {
      throw new PayrollPackError(
        "IE payroll: fortnight 27 needs the TDM week-53 / fortnight-27 rules — refused by name",
      );
    }
    return fortnight;
  }
  if (periodsPerYear === 12) {
    return Number(payDate.slice(5, 7));
  }
  if (periodsPerYear === 13) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(payDate);
    if (!m) throw new PayrollPackError(`IE payroll: pay date is not an ISO date: "${payDate}"`);
    const start = Date.UTC(Number(m[1]), 0, 1);
    const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const index = Math.floor((day - start) / 86_400_000 / 28) + 1;
    if (index > 13 || index < 1) {
      throw new PayrollPackError(
        `IE payroll: four-weekly period ${index} is outside the 13-period year — refused by name`,
      );
    }
    return index;
  }
  throw new PayrollPackError(
    `IE payroll: pay frequency ${periodsPerYear}/year is not implemented — refused by name`,
  );
}

/** Phase 9 — IE pack statutory pass (PAYE + Class A PRSI + standard USC). */
export async function computeIeStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const {
    tx, orgId, documentId, employeePartyId, taxYear, region, run,
    periodsPerYear: P, income, nonPeriodic, pensionable,
    deduction, pushStatutory, certificateFor, assertRegionSupported,
  } = ctx;
  assertRegionSupported(region);
  const payDate = run.pay_date;
  if (payDate == null || payDate === "") {
    throw new PayrollPackError("IE payroll: the run has no pay date, so no edition resolves");
  }
  const rpn = certificateFor("ie_rpn");
  const hasRpn = rpn !== null && rpn.onFile;
  const answer = (key: string): string | null => (hasRpn ? (rpn!.answers[key] ?? null) : null);
  const ytd = await ieEmployeeYtd({ tx, orgId, employeePartyId, taxYear, documentId });

  // Taxable pay is gross less ordinary employee pension contributions
  // (Revenue: "Taxable pay is the amount of your gross pay less any ordinary
  // contributions made by you"). PRSI/USC assess on reckonable pay, which
  // pension contributions do NOT reduce ("no PRSI relief on pension
  // contributions"). Non-periodic pay is taxed as paid in the period
  // (retroactivePayTreatment "periodic").
  const pensionDeduction = deduction("pension_f");
  const taxableBase = add(add(income, nonPeriodic), neg(pensionDeduction));
  const elapsed = elapsedPeriodsForPayDate(payDate, P);
  const rpnNum = (key: string): string => answer(key) ?? "0";

  const statutory = calculateIeStatutory({
    payDate,
    periodsPerYear: P,
    basis: (answer("pay_basis") ?? "cumulative") === "week1" ? "week1" : "cumulative",
    hasRpn,
    taxCreditsAnnual: rpnNum("tax_credits_total"),
    rateBandAnnual: rpnNum("rate_band_total"),
    taxablePayPeriod: taxableBase,
    taxablePayYtd: add(ytd.taxbase, rpnNum("prior_cumulative_pay")),
    // grossYtd reuses the prior taxable pay as the prior-gross proxy: exact
    // when the previous employment had no pre-tax pension deductions.
    taxPaidYtd: add(ytd.tax, rpnNum("prior_cumulative_tax")),
    reckonablePayPeriod: pensionable,
    grossPayYtd: add(ytd.gross, rpnNum("prior_cumulative_pay")),
    uscPaidYtd: add(ytd.usc, rpnNum("prior_cumulative_usc")),
    uscExempt: hasRpn && (answer("usc_exempt") === "true"),
    uscReducedEligible: false,
    elapsedPeriods: elapsed,
  });

  pushStatutory("ie_paye", "deduction", "PAYE income tax", statutory.paye, 110);
  pushStatutory("prsi", "deduction", "PRSI (employee)", statutory.prsiEmployee, 120);
  pushStatutory("usc", "deduction", "Universal Social Charge", statutory.usc, 130);
  pushStatutory("prsi", "employer_contribution", "PRSI (employer)", statutory.prsiEmployer, 210);
  return {
    IE_PAYE: statutory.paye,
    IE_PRSI_EE: statutory.prsiEmployee,
    IE_PRSI_ER: statutory.prsiEmployer,
    IE_USC: statutory.usc,
    IE_TAXBASE: taxableBase,
    IE_SUBCLASS: statutory.prsiSubclass,
    IE_EDITION: statutory.edition,
  };
}

export const IE_PAYROLL_PACK: IePayrollPack = {
  country: "IE",
  name: "Ireland",
  // Revenue (Tax Reference Numbers, stamp duty TDM): "PPS numbers contain
  // 7 digits followed by either one or two letters, for example, 1234567D"
  // (Citizens Information: "always 7 numbers followed by either one or
  // 2 letters"). No year-end filing is declared by this pack, so neededFor
  // is null and the missing-identifier warnings stay silent for Ireland.
  employeeIdentifier: {
    label: "PPSN",
    pattern: "\\d{7}[A-Z]{1,2}",
    formatHelp: "7 digits followed by 1–2 letters",
    example: "1234567T",
    requiredForPayroll: true,
    neededFor: null,
    citation: "Revenue: 'PPS numbers contain 7 digits followed by either one or two letters, for example, 1234567D'",
    numericEntry: false,
  },
  installable: true,
  // Revenue's engine computes euro; the Irish tax year is the calendar year.
  statutoryCurrency: "EUR",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  // One national region, fully computed end to end for 2026. Ireland levies
  // no county or city income tax on wages, so IE is the only region.
  regions: {
    label: "region",
    known: ["IE"],
    supported: ["IE"],
    unsupportedReason: "PAYE/PRSI/USC withholding for {region} is not implemented by the IE payroll "
      + "pack — Ireland has a single national payroll region (IE)",
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
  computeStatutory: computeIeStatutory,
  statutoryEngineLabel: "PAYE",
};
