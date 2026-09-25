/**
 * The GB pack's declarations: the nations the engine can withhold for, the
 * certificates its employees file, and the nations that withhold.
 *
 * Authored HERE, in the pack, beside the (refusing) engine that reads them —
 * the same arrangement `engine/src/payroll/us/jurisdictions.ts` uses. Nothing
 * in the generic layer names a nation, a starter checklist, or a tax code.
 *
 * Workplace pension: the assessment certificate explicitly limits automatic
 * computation to minimum qualifying-earnings schemes using net-pay deductions.
 * Other bases and contribution methods refuse by name in compute-statutory.ts.
 */

import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";
import type {
  PayrollPackWithholding,
  PayrollRegionWithholding,
} from "../withholding-jurisdictions.ts";
import type { PayrollRegionCoverage } from "../packs.ts";
import { GB_NATIONS } from "./rates.ts";

export const GB_NATION_NAMES: Readonly<Record<string, string>> = {
  ENG: "England",
  SCT: "Scotland",
  WLS: "Wales",
  NIR: "Northern Ireland",
};

/**
 * Which nations the GB engine withholds income tax for: England, Wales and
 * Northern Ireland, whose shared rUK bands are transcribed in rates.ts from
 * HMRC's employer tables (the England/NI and Wales tables are identical),
 * AND Scotland, whose own starter/basic/intermediate/higher/advanced/top
 * bands are transcribed as the SCT edition (GB_SCT_BANDS — the employer
 * rates page's Scotland section agreeing with
 * https://www.gov.uk/scottish-income-tax to the pound). Scotland's bands
 * are set in Edinburgh under the Scotland Act 1998, so SCT stays in
 * `regionsWithOwnTables`: a year loads for SCT only through its own
 * edition, never by falling through to rUK. NIC is reserved and UK-wide —
 * no nation has its own NIC table.
 */
export const GB_REGIONS: PayrollRegionCoverage = {
  label: "nation",
  known: [...GB_NATIONS],
  regionNames: GB_NATION_NAMES,
  supported: ["ENG", "WLS", "NIR", "SCT"],
  unsupportedReason:
    "PAYE income tax withholding for {region} is not implemented by the GB payroll pack.",
};

// ===========================================================================
// Certificates
// ===========================================================================

/**
 * The starter checklist (the former P46).
 *
 * Filed by the EMPLOYEE when they have no recent P45 — which is why it is a
 * certificate and not a profile fact. It carries the starter declaration
 * (A/B/C: which the employer reports on the first Full Payment Submission),
 * the student-loan plan, and the postgraduate-loan question. It is NOT a W-4 clone: there are no
 * allowances, no filing statuses, no extra withholding amount — the checklist
 * routes the employee to an emergency code and HMRC issues the real one.
 *
 * `storage: "certificate_rows"`: a new certificate on the new storage, so no
 * profile-column mapping is declared and none is needed.
 */
const GB_STARTER_CHECKLIST: PayrollCertificate = {
  key: "gb_starter_checklist",
  form: "Starter checklist",
  label: "Starter checklist (new employee without a P45)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "HMRC Starter checklist for PAYE (https://www.gov.uk/guidance/starter-checklist-for-paye); "
    + "employer guide https://www.gov.uk/new-employee-tax-code; student-loan payroll specification "
    + "https://www.gov.uk/government/publications/payroll-technical-specifications-student-loans/collection-of-student-loans-from-6-april-2026",
  summary:
    "Completed by a new starter who has no recent P45, before the first payday. "
    + "It sets the starter declaration reported on the first Full Payment Submission "
    + "and records the student-loan plan; HMRC then issues the employee's tax code.",
  storage: "certificate_rows",
  fields: [
    {
      key: "starter_declaration",
      label: "Starter declaration",
      kind: "choice",
      required: true,
      choices: [
        {
          value: "A",
          label: "A — first job since last 6 April",
          help: "This is the employee's first job since the last 6 April; they have not been "
            + "receiving taxable Jobseeker's Allowance, Employment and Support Allowance, or "
            + "Incapacity Benefit, and are not in receipt of a State, company or private pension.",
        },
        {
          value: "B",
          label: "B — second job, other income untaxed",
          help: "This is now the employee's only job, but since last 6 April they have had another "
            + "job, or have received taxable Jobseeker's Allowance, Employment and Support Allowance, "
            + "or Incapacity Benefit — without a P45 for it.",
        },
        {
          value: "C",
          label: "C — other job or pension continues",
          help: "The employee has another job or receives a State, company or private pension. "
            + "With declaration C only the BR or 0T codes may be used.",
        },
      ],
      help: "The employee's declaration determines the emergency tax code and is reported "
        + "to HMRC on the first Full Payment Submission.",
    },
    {
      key: "student_loan_plan",
      label: "Student loan plan",
      kind: "choice",
      required: true,
      choices: [
        { value: "none", label: "No student or postgraduate loan" },
        { value: "plan_1", label: "Plan 1" },
        { value: "plan_2", label: "Plan 2" },
        { value: "plan_4", label: "Plan 4 (Scotland)" },
        { value: "plan_5", label: "Plan 5 (postgraduate-plan undergraduate)" },
      ],
      help: "Select the employee's active undergraduate student-loan plan. If they also have a "
        + "postgraduate loan, record that separately below; both deductions can apply together.",
    },
    {
      key: "student_loan_postgraduate",
      label: "Postgraduate loan repayment applies",
      kind: "flag",
      required: true,
      help: "Select yes when HMRC's PGL1 notice, the P45, or the employee's starter information "
        + "requires postgraduate-loan deductions. This can be yes at the same time as an "
        + "undergraduate plan.",
    },
  ],
};

/**
 * The PAYE coding notice (P6/P9): the tax code itself.
 *
 * Issued by HMRC TO THE EMPLOYER, not filed by the employee — which is why it
 * is a separate certificate from the checklist rather than a field on it. The
 * `code` kind is the channel's short-free-string field (a PSD code, a school
 * district number, a tax code like 1257L or S1257L); no channel addition was
 * needed. The Scottish `S` prefix is carried inside the code value, so no
 * separate Scottish certificate exists.
 */
const GB_TAX_CODE_NOTICE: PayrollCertificate = {
  key: "gb_tax_code_notice",
  form: "P6/P9",
  label: "PAYE coding notice (tax code)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "HMRC PAYE coding notices to employers; tax-code guide https://www.gov.uk/new-employee-tax-code",
  summary:
    "HMRC's tax code for the employee (for example 1257L, S1257L for a Scottish taxpayer, "
    + "BR, 0T), received as a P6/P9 coding notice. Operated until HMRC issues a new one.",
  storage: "certificate_rows",
  fields: [
    {
      key: "tax_code",
      label: "Tax code",
      kind: "code",
      required: true,
      help: "The code exactly as HMRC issued it, including any S prefix for a Scottish taxpayer "
        + "and any week-1/month-1 marker operated non-cumulatively.",
    },
    {
      key: "non_cumulative",
      label: "Operated on a week-1/month-1 (non-cumulative) basis",
      kind: "flag",
      help: "Set when the coding notice carries a week-1/month-1 marker: each pay period is "
        + "taxed standalone rather than cumulatively across the tax year.",
    },
  ],
};

/** Employer-recorded category letter used to select the HMRC Class 1 table. */
const GB_NIC_CATEGORY_RECORD: PayrollCertificate = {
  key: "gb_nic_category",
  form: "National Insurance category record",
  label: "National Insurance category letter",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "HMRC National Insurance rates and categories (https://www.gov.uk/national-insurance-rates-letters/category-letters)",
  summary:
    "Employer-recorded category letter and director status used to select Class 1 NIC rules. "
    + "The employer must establish the correct letter from HMRC guidance.",
  storage: "certificate_rows",
  fields: [
    {
      key: "category_letter",
      label: "Category letter",
      kind: "choice",
      required: true,
      choices: ["A", "B", "C", "D", "E", "F", "H", "I", "J", "K", "L", "M", "N", "S", "V", "X", "Z"]
        .map((value) => ({ value, label: value })),
      help:
        "Use the letter determined by the employee's circumstances and workplace. Payroll currently "
        + "calculates category A only and refuses every other category by name.",
    },
    {
      key: "director_status",
      label: "Company director during this employment period",
      kind: "choice",
      required: true,
      choices: [
        { value: "director", label: "Company director" },
        { value: "not_director", label: "Not a company director" },
      ],
      help: "Record the effective-dated status for NIC; directors use a cumulative annual or pro-rata earnings period.",
    },
    {
      key: "directorship_start_date",
      label: "Directorship start date",
      kind: "code",
      help: "For a director, record the appointment date as YYYY-MM-DD; NIC is not calculated until the annual/pro-rata method is supported.",
    },
  ],
};

const GB_WORKPLACE_PENSION_ASSESSMENT: PayrollCertificate = {
  key: "gb_workplace_pension",
  form: "Workplace pension assessment",
  label: "Automatic-enrolment eligibility and scheme record",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "The Pensions Regulator automatic-enrolment earnings thresholds "
    + "(https://www.thepensionsregulator.gov.uk/business-advisers/automatic-enrolment-guide-for-business-advisers/automatic-enrolment-earnings-threshold); "
    + "DWP 2026/27 review (https://www.gov.uk/government/publications/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627)",
  summary:
    "Effective-dated employer assessment of age, eligibility, and enrolment. Eligible, opted-in, or postponed cases refuse until qualifying earnings and scheme contributions are calculated.",
  storage: "certificate_rows",
  fields: [
    {
      key: "age_band",
      label: "Worker age band for automatic enrolment",
      kind: "choice",
      required: true,
      choices: [
        { value: "under_22", label: "16 to 21" },
        { value: "22_to_state_pension_age", label: "22 to State Pension age" },
        { value: "state_pension_age_or_over", label: "State Pension age or older" },
        { value: "under_16_or_other_exclusion", label: "Outside the age range or otherwise excluded" },
      ],
      help: "Use the worker's documented age at this assessment's effective date.",
    },
    {
      key: "worker_status",
      label: "Automatic-enrolment worker assessment",
      kind: "choice",
      required: true,
      choices: [
        { value: "eligible_jobholder", label: "Eligible jobholder" },
        { value: "noneligible_jobholder", label: "Non-eligible jobholder" },
        { value: "entitled_worker", label: "Entitled worker" },
      ],
      help: "Record the employer's assessment for this job and pay reference period.",
    },
    {
      key: "enrolment_status",
      label: "Workplace pension enrolment status",
      kind: "choice",
      required: true,
      choices: [
        { value: "enrolled", label: "Enrolled in a qualifying scheme" },
        { value: "not_enrolled", label: "Not enrolled" },
        { value: "opted_out", label: "Valid opt-out currently in force" },
        { value: "opted_in", label: "Opted in or joined voluntarily" },
        { value: "postponed", label: "Postponement period" },
      ],
      help: "Use the scheme's current effective-dated enrolment record; unsupported contribution cases refuse at payroll.",
    },
    {
      key: "scheme_basis",
      label: "Pension scheme contribution basis",
      kind: "choice",
      choices: [
        { value: "qualifying_earnings", label: "Qualifying earnings" },
        { value: "certified_alternative", label: "Certified alternative basis" },
      ],
      help: "The payroll pack has no verified calculation for either basis yet; eligible contributions refuse by name.",
    },
  ],
};

/** Employer's scheme-terms record for auto-enrolment minimums pricing. Kept distinct
 * from the eligibility assessment above: that gate decides WHO must be enrolled;
 * this one carries the scheme basis and deduction method the minimums price from. */
const GB_WORKPLACE_PENSION_SCHEME_TERMS: PayrollCertificate = {
  key: "gb_workplace_pension_assessment",
  form: "Workplace pension assessment",
  label: "Workplace pension assessment and scheme terms",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "Pensions Regulator 2026/27 automatic-enrolment thresholds "
    + "(https://www.thepensionsregulator.gov.uk/business-advisers/automatic-enrolment-guide-for-business-advisers/automatic-enrolment-earnings-threshold); "
    + "DWP threshold review https://www.gov.uk/government/publications/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627; "
    + "minimum contributions https://www.gov.uk/workplace-pensions/what-you-your-employer-and-the-government-pay",
  summary:
    "Employer assessment for this pay reference period: worker age band, current membership status, "
    + "and scheme terms. Reassess when the worker's age band or pension status changes.",
  storage: "certificate_rows",
  fields: [
    {
      key: "age_band", label: "Worker age band", kind: "choice", required: true,
      choices: [
        { value: "under_22", label: "Under age 22" },
        { value: "22_to_state_pension_age", label: "Age 22 to State Pension age" },
        { value: "state_pension_age_or_over", label: "State Pension age or over" },
      ],
      help: "Use the worker's age against State Pension age when assessing automatic-enrolment duties.",
    },
    {
      key: "membership_status", label: "Current workplace pension status", kind: "choice", required: true,
      choices: [
        { value: "not_eligible", label: "Assessed as not eligible for automatic enrolment" },
        { value: "active_member", label: "Enrolled or opted in; contributions are due" },
        { value: "valid_opt_out", label: "Valid opt-out is in effect" },
      ],
      help: "Do not select not eligible for an age-eligible worker whose pay reaches the applicable earnings trigger.",
    },
    {
      key: "scheme_basis", label: "Contribution basis", kind: "choice", required: true,
      choices: [
        { value: "not_applicable", label: "No contributions due" },
        { value: "qualifying_earnings_minimum", label: "Statutory minimum on qualifying earnings" },
        { value: "other_basis", label: "Another certified scheme basis" },
      ],
      help: "The engine prices only statutory minimum contributions on qualifying earnings.",
    },
    {
      key: "deduction_method", label: "Employee contribution method", kind: "choice", required: true,
      choices: [
        { value: "not_applicable", label: "No contributions due" },
        { value: "net_pay", label: "Net-pay arrangement" },
        { value: "relief_at_source", label: "Relief at source" },
        { value: "salary_sacrifice", label: "Salary sacrifice" },
      ],
      help: "The engine prices the 5% employee share as a net-pay deduction; other methods are refused by name.",
    },
  ],
};

export const GB_CERTIFICATES: PayrollPackCertificates = {
  country: "GB",
  certificates: [GB_STARTER_CHECKLIST, GB_TAX_CODE_NOTICE, GB_NIC_CATEGORY_RECORD, GB_WORKPLACE_PENSION_ASSESSMENT, GB_WORKPLACE_PENSION_SCHEME_TERMS],
};

// ===========================================================================
// Withholding nations
// ===========================================================================

function gbRegion(nation: string, label: string, implemented: boolean): PayrollRegionWithholding {
  return {
    region: nation,
    label,
    implemented,
    unimplementedReason: implemented
      ? undefined
      : `PAYE withholding for ${label} is not implemented: Scotland prices against its own `
      + "bands and no SCT edition is transcribed (see GB_TAX_YEARS).",
    // NOT ESTABLISHED: whether the nation withholds from nonresidents' wages
    // earned there, and what it requires of a resident's out-of-nation wages.
    // Declared `unknown` (twice) rather than guessed, so a cross-border
    // employee is refused by name instead of silently mis-withheld.
    taxesNonresidentWages: false,
    residentWithholding: "unknown",
    residentWithholdingImplemented: false,
    certificateKey: "gb_starter_checklist",
    subRegions: [],
    // The UK levies no sub-national income tax: no councils, cities or
    // boroughs below the nation take their own certificate, so there is
    // nothing for a conflict rule to compare — and declaring the rule keeps a
    // future levy from inheriting a default nobody chose.
    subRegionConflictRule: "both",
    citation:
      "HMRC Rates and thresholds for employers 2026 to 2027 "
      + "(https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027)",
  };
}

export const GB_WITHHOLDING: PayrollPackWithholding = {
  country: "GB",
  regions: [
    gbRegion("ENG", "England PAYE", true),
    gbRegion("SCT", "Scotland PAYE", true),
    gbRegion("WLS", "Wales PAYE", true),
    gbRegion("NIR", "Northern Ireland PAYE", true),
  ],
};
