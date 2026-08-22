/**
 * Mississippi withholding declarations — Form 89-350 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form 89-350, Mississippi Employee's Withholding Exemption Certificate. */
export const MS_CERTIFICATE: PayrollCertificate = {
  key: "us_ms_89350",
  form: "89-350",
  label: "Mississippi Employee's Withholding Exemption Certificate",
  scope: { level: "region", region: "MS" },
  purpose: "withholding",
  citation:
    "Mississippi Department of Revenue, Pub. 89-700-25-1 (Rev. 07/25); "
    + "Computer Payroll Accounting flowchart (Rev. 8/13/25); Form 89-350. "
    + "Federal Form W-4 may not be used.",
  summary:
    "Sets Mississippi filing status and the dollar exemption claimed on line 6. "
    + "If the employee does not furnish an 89-350, Pub. 89-700 requires "
    + "withholding as Single with zero exemption.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Form 89-350 filing status",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Line 1 — Single ($2,300 standard deduction)" },
        { value: "head_of_family", label: "Line 3 — Head of Family ($3,400 standard deduction)" },
        {
          value: "married_one",
          label: "Line 2(a) — Married, spouse not employed ($4,600 standard deduction)",
        },
        {
          value: "married_both",
          label: "Line 2(b) — Married, both spouses employed ($2,300 standard deduction)",
        },
      ],
      help:
        "The flowchart's MS code. Married one-spouse uses the joint $4,600 "
        + "standard deduction; both-spouses splits it to $2,300 each. Default "
        + "Single is Pub. 89-700's missing-form rule (Tables A, zero exemption).",
    },
    {
      key: "exemption",
      label: "Line 6 — Total amount of exemption claimed",
      kind: "amount",
      decimals: 4,
      min: "0",
      default: "0",
      help:
        "The dollar total from Form 89-350 line 6 (personal exemption plus "
        + "dependents, age, and blindness). Default zero is Pub. 89-700's "
        + "missing-form rule — withhold without the benefit of exemption.",
    },
    {
      key: "additional_per_period",
      label: "Line 7 — Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A written agreement may withhold more than, but not less than, the "
        + "required amount. Added AFTER the flowchart amount is rounded to "
        + "the nearest whole dollar.",
    },
    {
      key: "exempt",
      label: "Line 8 — Military spouse (MSRRA) exempt from Mississippi withholding",
      kind: "flag",
      help:
        "A current Exempt on line 8, with the supporting military-spouse "
        + "documents Pub. 89-700 requires, withholds zero.",
    },
  ],
};

export const MS_REGION: PayrollRegionWithholding = {
  region: "MS",
  label: "Mississippi income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ms_89350",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Mississippi Department of Revenue, Pub. 89-700-25-1 (Rev. 07/25); "
    + "Computer Payroll Accounting flowchart (Rev. 8/13/25); Form 89-350",
};
