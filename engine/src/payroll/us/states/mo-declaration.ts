/**
 * Missouri withholding declarations — Form MO W-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form MO W-4, Employee's Withholding Certificate. */
export const MO_CERTIFICATE: PayrollCertificate = {
  key: "us_mo_mow4",
  form: "MO W-4",
  label: "Missouri Employee's Withholding Certificate",
  scope: { level: "region", region: "MO" },
  purpose: "withholding",
  citation:
    "Missouri Department of Revenue, 2026 Missouri Withholding Tax Formula; "
    + "Form 4282 Employer's Tax Guide (Revised 03-2026); Form MO W-4. "
    + "Missouri has no reciprocity agreement with any other state.",
  summary:
    "Sets Missouri filing status for the standard deduction. If the employee "
    + "does not complete Form MO W-4, Form 4282 requires withholding at a "
    + "single tax rate.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Filing status on Form MO W-4",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single ($16,100 standard deduction)" },
        { value: "married_spouse_works", label: "Married and spouse works ($16,100)" },
        { value: "married_separate", label: "Married filing separate ($16,100)" },
        {
          value: "married_spouse_does_not_work",
          label: "Married and spouse does not work ($32,200)",
        },
        { value: "head_household", label: "Head of household ($24,150)" },
      ],
      help:
        "The 2026 formula subtracts the printed standard deduction for this "
        + "status and no other allowance. Default Single is Form 4282's own "
        + "rule when no MO W-4 is on file.",
    },
    {
      key: "additional_per_period",
      label: "Line 2 — Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A written additional amount on Form MO W-4 Line 2. Added AFTER the "
        + "formula is de-annualized and rounded to the nearest whole dollar.",
    },
    {
      key: "exempt",
      label: "Exempt from Missouri withholding",
      kind: "flag",
      help:
        "A current exempt claim on Form MO W-4 withholds zero. Employees must "
        + "file a new MO W-4 annually to continue the exemption.",
    },
  ],
};

export const MO_REGION: PayrollRegionWithholding = {
  region: "MO",
  label: "Missouri income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_mo_mow4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Missouri Department of Revenue, 2026 Missouri Withholding Tax Formula; "
    + "Form 4282 (Revised 03-2026); Form MO W-4",
};
