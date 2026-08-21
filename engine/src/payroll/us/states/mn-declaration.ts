/**
 * Minnesota withholding certificate and region declaration.
 *
 * Authored beside the engine so the parent can wire these into
 * `us/jurisdictions.ts` without this module importing that file. Shape matches
 * IL_W4 / NC_NC4 / NC_REGION.
 *
 * Sources: Form W-4MN (Rev. 4/26); 2026 Minnesota Withholding Tax
 * Instructions and Tables pp. 3–4; Form MWR for Tax Year 2026.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form W-4MN — Minnesota Employee Withholding Certificate (Rev. 4/26). */
export const MN_CERTIFICATE: PayrollCertificate = {
  key: "us_mn_w4mn",
  form: "W-4MN",
  label: "Minnesota Employee Withholding Certificate",
  scope: { level: "region", region: "MN" },
  purpose: "withholding",
  citation:
    "Minnesota Form W-4MN (Rev. 4/26); 2026 Minnesota Withholding Tax Instructions and Tables "
    + "(Computer Formula p. 34)",
  summary:
    "Sets Minnesota withholding allowances and marital status. If no completed W-4MN is on file, "
    + "the employer must withhold at the single filing status with zero allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "marital_status", label: "Marital status", kind: "choice",
      choices: [
        { value: "single", label: "Single; Married, but legally separated; or Spouse is a nonresident alien" },
        { value: "married", label: "Married" },
        {
          value: "married_higher_single",
          label: "Married, but withhold at higher Single rate",
          help: "Uses the Single Step-5 chart.",
        },
      ],
      default: "single", required: true,
      help: "If the employee does not complete a Form W-4MN, withhold at the single filing status "
        + "with zero allowances.",
    },
    {
      key: "allowances", label: "Line 1 — Minnesota allowances", kind: "count",
      min: "0", max: "99", default: "0",
      help: "From Section 1 Step F (or the itemized-deductions worksheet Step 10). Worth $5,300 "
        + "a year each in 2026. Default zero: that is the booklet's no-certificate rule.",
    },
    {
      key: "additional_per_period", label: "Line 2 — Additional Minnesota withholding per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "A flat dollar amount, not a percentage. Added after the formula.",
    },
    {
      key: "exempt", label: "Section 2 — Exempt from Minnesota withholding", kind: "flag",
      help: "Boxes A–F. A new W-4MN is due by February 15 each year; without one, withhold as "
        + "single with zero allowances. Reciprocity for Michigan or North Dakota is Form MWR, "
        + "not this box.",
    },
  ],
};

/**
 * Form MWR — Reciprocity Exemption/Affidavit of Residency (tax year 2026).
 *
 * Minnesota's agreements are with Michigan and North Dakota only. Illinois is
 * not one: an Illinois resident working in Minnesota is withheld Minnesota tax
 * in full. Due each year by February 28 (or within 30 days of hire / move).
 */
export const MN_MWR: PayrollCertificate = {
  key: "us_mn_mwr",
  form: "MWR",
  label: "Reciprocity Exemption/Affidavit of Residency (Minnesota)",
  scope: { level: "region", region: "MN" },
  purpose: "non_residence",
  citation:
    "Minnesota Form MWR for Tax Year 2026; 2026 Minnesota Withholding Tax Instructions and "
    + "Tables p. 4, \"Reciprocity for Residents of Michigan or North Dakota\"",
  summary:
    "Claims exemption from Minnesota withholding under the Michigan or North Dakota reciprocity "
    + "agreement. \"If your employees … give you a properly completed Form MWR … each year.\" "
    + "Without it, Minnesota tax is withheld.",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state", label: "State of permanent residence", kind: "choice",
      choices: [
        { value: "MI", label: "Michigan" },
        { value: "ND", label: "North Dakota" },
      ],
      required: true,
      help: "Minnesota has reciprocal agreements with exactly these two states. The employee must "
        + "return to that residence at least once a month.",
    },
  ],
};

export const MN_REGION: PayrollRegionWithholding = {
  region: "MN",
  label: "Minnesota income tax",
  implemented: true,
  // Booklet p. 4: withhold from a nonresident on Minnesota-source wages unless
  // reciprocity (MI/ND on Form MWR) or expected pay is under $15,300.
  taxesNonresidentWages: true,
  // Booklet p. 5: a Minnesota resident working in another state (other than
  // Michigan or North Dakota) "may be required" to have Minnesota withheld —
  // the employer completes a worksheet. Declared required as the base rule;
  // the worksheet and the reciprocity exception are not implemented.
  residentWithholding: "required",
  residentWithholdingImplemented: false,
  certificateKey: "us_mn_w4mn",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Minnesota Department of Revenue, 2026 Minnesota Withholding Tax Instructions and Tables, "
    + "Computer Formula (p. 34); Form W-4MN (Rev. 4/26)",
};
