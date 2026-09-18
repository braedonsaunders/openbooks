/**
 * The GB pack's declarations: the nations the engine can withhold for, the
 * certificates its employees file, and the nations that withhold.
 *
 * Authored HERE, in the pack, beside the (refusing) engine that reads them —
 * the same arrangement `engine/src/payroll/us/jurisdictions.ts` uses. Nothing
 * in the generic layer names a nation, a starter checklist, or a tax code.
 *
 * Two deliberate non-declarations:
 *
 * - Student-loan and postgraduate-loan repayments: the April 2026 plan
 *   thresholds are published
 *   (https://www.gov.uk/guidance/special-rules-for-student-loans) and the
 *   starter checklist already ASKS the plan question (see GB_STARTER_CHECKLIST
 *   below), but no slot or engine consumes the answer yet. The answer is
 *   collected, not computed — declaring a slot would seed components the
 *   engine never fills, which is silent wrong money dressed as completeness.
 * - Workplace-pension auto-enrolment: the 2026/27 trigger (£10,000) and
 *   qualifying-earnings band (£6,240–£50,270) are published (see rates.ts),
 *   but minimum contributions ride each employer's scheme, not a pack table.
 *   No slot until a sourced engine exists.
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
 * (A/B/C: which the employer reports on the first Full Payment Submission)
 * and the student-loan plan question. It is NOT a W-4 clone: there are no
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
    + "employer guide https://www.gov.uk/new-employee-tax-code",
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
        { value: "postgraduate", label: "Postgraduate loan" },
      ],
      help: "Collected from the starter checklist's student-loan question. Recorded for the "
        + "future student-loan slot; no repayments are computed from it yet (see the module header).",
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

export const GB_CERTIFICATES: PayrollPackCertificates = {
  country: "GB",
  certificates: [GB_STARTER_CHECKLIST, GB_TAX_CODE_NOTICE],
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
