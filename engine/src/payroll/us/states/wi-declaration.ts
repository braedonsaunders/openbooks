/**
 * Wisconsin withholding certificate and region declaration.
 *
 * Authored beside the engine so the parent can wire these into
 * `us/jurisdictions.ts` without this module importing that file. Shape matches
 * IL_W4 / NC_NC4 / NC_REGION.
 *
 * Sources: Form WT-4 (W-204 R. 8-23); Publication W-166 (January 2026);
 * Form W-220 (R. 7-20); Publication 121 Reciprocity (January 2026).
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form WT-4 — Employee's Wisconsin Withholding Exemption Certificate (R. 8-23). */
export const WI_CERTIFICATE: PayrollCertificate = {
  key: "us_wi_wt4",
  form: "WT-4",
  label: "Employee's Wisconsin Withholding Exemption Certificate",
  scope: { level: "region", region: "WI" },
  purpose: "withholding",
  citation:
    "Wisconsin Form WT-4 (W-204 R. 8-23); Publication W-166, Withholding Tax Guide (January 2026)",
  summary:
    "Sets Wisconsin withholding exemptions and marital status. W-166: if the employee fails to "
    + "furnish a WT-4, \"the employee shall be considered as claiming zero withholding exemptions.\"",
  storage: "certificate_rows",
  fields: [
    {
      key: "marital_status", label: "Withholding status", kind: "choice",
      choices: [
        { value: "single", label: "Single (or married but legally separated)" },
        { value: "married", label: "Married" },
        {
          value: "married_higher_single",
          label: "Married, but withhold at higher Single rate",
          help: "Uses the Single deduction formula.",
        },
      ],
      default: "single", required: true,
      help: "W-166 names zero exemptions as the no-certificate rule and does not name a marital "
        + "status; Single is the form's first box and the higher-tax default.",
    },
    {
      key: "exemptions", label: "Line 1(d) — Total withholding exemptions", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Lines 1(a)–(c) added: self, spouse, dependents. Worth $400 a year each. Default "
        + "zero: W-166 p. 8.",
    },
    {
      key: "additional_per_period",
      label: "Line 2 — Additional amount per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Only if the employer agrees. Added after the formula.",
    },
    {
      key: "exempt", label: "Line 3 — Complete exemption from withholding", kind: "flag",
      help: "No Wisconsin liability last year and none expected this year. Expires April 30 of "
        + "the next year unless a new WT-4 is filed. Federal Form W-4 cannot claim this. "
        + "Reciprocity is Form W-220, not this line.",
    },
  ],
};

/**
 * Form W-220 — Nonresident Employee's Withholding Reciprocity Declaration (R. 7-20).
 *
 * Wisconsin's agreements are with Illinois, Indiana, Kentucky, and Michigan.
 * "Written verification is required to relieve the employer from withholding
 * Wisconsin income taxes" (W-166 p. 8). W-220 "may be used for this purpose."
 */
export const WI_W220: PayrollCertificate = {
  key: "us_wi_w220",
  form: "W-220",
  label: "Nonresident Employee's Withholding Reciprocity Declaration (Wisconsin)",
  scope: { level: "region", region: "WI" },
  purpose: "non_residence",
  citation:
    "Wisconsin Form W-220 (R. 7-20); Publication W-166 (January 2026) p. 8; Publication 121 "
    + "Reciprocity (January 2026)",
  summary:
    "Claims exemption from Wisconsin withholding under a reciprocal agreement. Residence in "
    + "Illinois, Indiana, Kentucky or Michigan is not enough on its own: written verification "
    + "is required.",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state", label: "I declare that while working in Wisconsin I am a legal resident of",
      kind: "choice",
      choices: [
        { value: "IL", label: "Illinois" },
        { value: "IN", label: "Indiana" },
        { value: "KY", label: "Kentucky" },
        { value: "MI", label: "Michigan" },
      ],
      required: true,
      help: "Wisconsin has reciprocal agreements with exactly these four states.",
    },
  ],
};

export const WI_REGION: PayrollRegionWithholding = {
  region: "WI",
  label: "Wisconsin income tax",
  implemented: true,
  // W-166 p. 8: wages paid to nonresidents for services performed in Wisconsin
  // are subject to withholding unless an exception (reciprocity, under $1,500
  // expected, interstate carrier, military spouse) applies.
  taxesNonresidentWages: true,
  // W-166 p. 7: "Wages paid to Wisconsin residents are subject to Wisconsin
  // withholding, whether paid for services performed entirely in Wisconsin,
  // partly in and partly outside Wisconsin, or entirely outside Wisconsin."
  // A special Minnesota arrangement and a voluntary out-of-state-employer
  // registration are exceptions this engine does not implement.
  residentWithholding: "required",
  residentWithholdingImplemented: false,
  certificateKey: "us_wi_wt4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Wisconsin Department of Revenue, Publication W-166, Withholding Tax Guide (January 2026), "
    + "Alternate Method (pp. 25–26); Form WT-4 (W-204 R. 8-23)",
};
