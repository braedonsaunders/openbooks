/**
 * West Virginia withholding declarations — Form IT-104 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form WV IT-104 / IT-104NR, Rev. 03/2023. */
export const WV_CERTIFICATE: PayrollCertificate = {
  key: "us_wv_it104",
  form: "IT-104",
  label: "West Virginia Employee's Withholding Exemption Certificate",
  scope: { level: "region", region: "WV" },
  purpose: "withholding",
  citation:
    "West Virginia Form WV IT-104 / IT-104NR (Rev. 03/2023); Form WV IT-100.2A (March 2026)",
  summary:
    "Sets West Virginia withholding exemptions and the optional one-earner schedule. If the "
    + "employee does not complete the form, no exemptions are claimed and the two-earner "
    + "percentage tables apply — IT-104's own warning is that withholding \"may not be "
    + "sufficient,\" not that the employer may skip withholding.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exemptions",
      label: "Line 4 — Total withholding exemptions",
      kind: "count",
      min: "0", max: "99", default: "0",
      help:
        "The sum of IT-104 lines 1–3 (self, spouse, dependents). Worth $2,000 a year each "
        + "(IT-100.2A Table 5). Default zero: an unfiled certificate claims no exemptions.",
    },
    {
      key: "one_earner",
      label: "Line 5 — Optional one-earner / one-job schedule",
      kind: "flag",
      help:
        "Checked only if the employee is single, head of household, or married with a "
        + "non-employed spouse, receives wages from only one job, and wants the lower "
        + "optional one-earner tables. Unchecked is the two-earner default the wage-bracket "
        + "tables themselves are computed from.",
    },
    {
      key: "additional_per_period",
      label: "Line 6 — Additional withholding per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Added AFTER the percentage method is rounded to the dollar.",
    },
    {
      key: "exempt",
      label: "IT-104NR — Resident of a reciprocal state",
      kind: "flag",
      help:
        "The employee is a legal resident of Kentucky, Maryland, Ohio, Pennsylvania or "
        + "Virginia and the only West Virginia-source income is wages. Upon a completed "
        + "IT-104NR the employer stops West Virginia withholding.",
    },
    {
      key: "military_spouse_exempt",
      label: "IT-104NR — Military spouse (SCRA / MSRRA)",
      kind: "flag",
      help:
        "The employee is in West Virginia solely to be with a servicemember spouse stationed "
        + "here under orders and maintains a domicile in another state. Attach a copy of the "
        + "spousal military identification card.",
    },
  ],
};

export const WV_REGION: PayrollRegionWithholding = {
  region: "WV",
  label: "West Virginia income tax",
  implemented: true,
  // TSD 381 (Rev. September 2025): nonresident employers with employees
  // working in West Virginia must withhold unless a published exemption applies.
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by IT-100.2A: whether a West Virginia resident's wages
  // earned entirely outside West Virginia must be withheld on. Declared unknown.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_wv_it104",
  // West Virginia publishes no local wage income tax an employer withholds.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "West Virginia Tax Division, Form WV IT-100.2A (March 2026); Form WV IT-104 "
    + "(Rev. 03/2023); TSD 381 (Rev. September 2025)",
};
