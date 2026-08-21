/**
 * Iowa withholding certificate and region declaration.
 *
 * Authored beside the engine so the parent can wire these into
 * `us/jurisdictions.ts` without this module importing that file. Shape matches
 * IL_W4 / NC_NC4 / NC_REGION.
 *
 * Sources: 2026 IA W-4 (44-019a, 11/13/2025); Iowa Withholding Formula
 * (November 2025, effective January 1, 2026); Form 44-016 (10/3/2024);
 * IAC 701—307.3(422).
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** 2026 IA W-4 — Employee Withholding Allowance Certificate (44-019a). */
export const IA_CERTIFICATE: PayrollCertificate = {
  key: "us_ia_iaw4",
  form: "IA W-4",
  label: "Iowa Employee Withholding Allowance Certificate",
  scope: { level: "region", region: "IA" },
  purpose: "withholding",
  citation:
    "2026 IA W-4 (44-019a, 11/13/2025); Iowa Withholding Formula For Taxable Wages Paid "
    + "Beginning January 1, 2026 (Released November 2025); IAC 701—307.3(422)",
  summary:
    "Sets Iowa withholding. IAC 701—307.3: if the employee fails to furnish a certificate, "
    + "\"the employee shall be considered as claiming no withholding allowances.\" A missing "
    + "marital status uses deduction column (A).",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status", label: "Filing status", kind: "choice",
      choices: [
        { value: "other", label: "Other (including Single)" },
        { value: "head_household", label: "Head of Household" },
        { value: "married_joint", label: "Married filing jointly" },
        { value: "qualifying_surviving_spouse", label: "Qualifying Surviving Spouse" },
      ],
      default: "other", required: true,
      help: "The 2026 formula: a missing marital status uses column (A). \"Other\" includes "
        + "single, married filing separately, and a joint filer who wants to withhold as single.",
    },
    {
      key: "spouse_earned_income",
      label: "If married filing jointly, does your spouse also have earned income?",
      kind: "flag",
      help: "Yes moves a joint filer (or qualifying surviving spouse) to column (A); No or "
        + "blank uses column (C). Ignored for Other and Head of Household.",
    },
    {
      key: "total_allowance", label: "Line 7 — Total allowances",
      kind: "amount", decimals: 4, min: "0", default: "0",
      help: "A DOLLAR amount (lines 1–6 added), not a headcount. Step 3A divides this by the "
        + "pay periods. Default zero: IAC 701—307.3.",
    },
    {
      key: "additional_per_period", label: "Line 8 — Additional amount per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Added after the 3.80% rate — Step 4's A.",
    },
    {
      key: "exempt", label: "Exemption from withholding (enter EXEMPT)", kind: "flag",
      help: "Iowa resident, no liability last year, none expected this year. Nonresidents may "
        + "not claim this. A new IA W-4 is due by February 15 to keep the claim.",
    },
    {
      key: "military_spouse_exempt",
      label: "Military spouse (MSRRA / Veterans Benefits Acts)", kind: "flag",
      help: "Present in Iowa solely to be with a uniformed-services spouse. File with a copy "
        + "of the spousal military identification card.",
    },
    {
      key: "pre_2024", label: "Most recent IA W-4 is from 2023 or earlier", kind: "flag",
      help: "Selects Steps 1B and 3B: two deduction columns and W = allowances × $40. Leave "
        + "off for a 2024, 2025, or 2026 IA W-4.",
    },
    {
      key: "pre_2024_marital", label: "Marital status on a 2023-or-earlier IA W-4", kind: "choice",
      choices: [
        { value: "single", label: "Single (or married but legally separated)" },
        { value: "married", label: "Married" },
      ],
      default: "single",
      help: "Only read when pre_2024 is set. Missing marital status uses column (A).",
    },
    {
      key: "pre_2024_allowances", label: "Allowances claimed on a 2023-or-earlier IA W-4",
      kind: "count", min: "0", max: "99", default: "0",
      help: "Only read when pre_2024 is set. Each one is worth $40 of W.",
    },
  ],
};

/**
 * Form 44-016 — Employee's Statement of Nonresidence in Iowa (10/3/2024).
 *
 * Iowa's only reciprocal agreement is with Illinois. "You are required to have
 * a copy of this form on file for each employee who is a resident of Illinois
 * … and who claims exemption from withholding of Iowa income tax."
 */
export const IA_44016: PayrollCertificate = {
  key: "us_ia_44016",
  form: "44-016",
  label: "Employee's Statement of Nonresidence in Iowa",
  scope: { level: "region", region: "IA" },
  purpose: "non_residence",
  citation:
    "Iowa Form 44-016 (10/3/2024); Iowa Department of Revenue, Iowa–Illinois Reciprocal "
    + "Agreement (revenue.iowa.gov)",
  summary:
    "Claims exemption from Iowa withholding under the Illinois reciprocal agreement. An "
    + "Illinois resident working in Iowa is taxable only to Illinois — and only if this form "
    + "is on file. Notify the employer within ten days of a residence change.",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state", label: "State of residence", kind: "choice",
      choices: [{ value: "IL", label: "Illinois" }],
      required: true,
      help: "Illinois is the ONLY state Iowa has a reciprocal agreement with.",
    },
  ],
};

export const IA_REGION: PayrollRegionWithholding = {
  region: "IA",
  label: "Iowa income tax",
  implemented: true,
  // IAC 701—307 and the withholding-information page: compensation paid for
  // services performed in Iowa is subject to Iowa withholding.
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by the 2026 formula booklet: whether Iowa requires an
  // employer to withhold from an Iowa RESIDENT's wages earned in another
  // state. Declared unknown rather than assumed.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ia_iaw4",
  // Iowa school-district surtax is claimed on the annual return / via extra
  // withholding on IA W-4 line 8 — the 2026 employer formula does not apply
  // a district rate.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Iowa Department of Revenue, Iowa Withholding Formula For Taxable Wages Paid Beginning "
    + "January 1, 2026 (Released November 2025); 2026 IA W-4 (44-019a, 11/13/2025)",
};
