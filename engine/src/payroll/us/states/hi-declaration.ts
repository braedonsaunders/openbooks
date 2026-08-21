/**
 * Hawaii withholding declarations — Form HW-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form HW-4, Employee's Withholding Allowance and Status Certificate. */
export const HI_CERTIFICATE: PayrollCertificate = {
  key: "us_hi_hw4",
  form: "HW-4",
  label: "Hawaii Employee's Withholding Allowance and Status Certificate",
  scope: { level: "region", region: "HI" },
  purpose: "withholding",
  citation:
    "Hawaii Department of Taxation, Booklet A, Employer's Tax Guide (Rev. 2025); "
    + "Form HW-4. Federal Form W-4 may not be used.",
  summary:
    "Sets Hawaii marital status and allowances. If the employee does not "
    + "furnish an HW-4, Booklet A requires withholding as single with no "
    + "allowance. Head of household is treated as single.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Marital status for Hawaii withholding",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single (including unmarried heads of household)" },
        { value: "married", label: "Married" },
      ],
      help:
        "Booklet A treats head of household as single. Default Single is the "
        + "publication's own rule when no HW-4 is on file.",
    },
    {
      key: "allowances",
      label: "Number of Hawaii withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each allowance is $1,144 a year. The annualized method also subtracts "
        + "the $4,350 extra lump-sum allowance. Default zero is Booklet A's "
        + "missing-form rule (single, no allowance).",
    },
    {
      key: "additional_per_period",
      label: "Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A written agreement may withhold more than, but not less than, the "
        + "required amount. Added AFTER the annualized method is de-annualized.",
    },
    {
      key: "exempt",
      label: "Exempt from Hawaii withholding",
      kind: "flag",
      help:
        "A current exempt claim on Form HW-4 withholds zero. Dating any "
        + "year-end lapse is certificate administration.",
    },
  ],
};

export const HI_REGION: PayrollRegionWithholding = {
  region: "HI",
  label: "Hawaii income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_hi_hw4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Hawaii Department of Taxation, Booklet A, Employer's Tax Guide (Rev. 2025); Form HW-4",
};
