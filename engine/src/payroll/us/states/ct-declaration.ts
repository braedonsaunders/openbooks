/**
 * Connecticut withholding declarations — Form CT-W4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form CT-W4, Employee's Withholding Certificate (Rev. 12/25). */
export const CT_CERTIFICATE: PayrollCertificate = {
  key: "us_ct_ctw4",
  form: "CT-W4",
  label: "Employee's Withholding Certificate (Connecticut)",
  scope: { level: "region", region: "CT" },
  purpose: "withholding",
  citation:
    "Connecticut Form CT-W4 (Rev. 12/25); TPG-211, 2026 Withholding Calculation Rules "
    + "(Rev. 12/25); Informational Publication 2026(1), Connecticut Employer's Tax Guide, "
    + "Circular CT",
  summary:
    "Sets the Connecticut withholding code (A, B, C, D, E, or F) and optional extra or "
    + "reduced withholding. \"If an employee fails to give you a completed Form CT-W4, "
    + "you must withhold at a flat rate of 6.99%, without allowance for exemption.\"",
  storage: "certificate_rows",
  fields: [
    {
      key: "withholding_code",
      label: "Line 1 — Withholding Code",
      kind: "choice",
      choices: [
        { value: "A", label: "A — Married filing jointly / qualifying surviving spouse" },
        { value: "B", label: "B — Married filing separately" },
        { value: "C", label: "C — Head of household" },
        { value: "D", label: "D — Highest withholding (no exemption or credit)" },
        { value: "E", label: "E — Exempt (no Connecticut income-tax liability expected)" },
        { value: "F", label: "F — Single" },
      ],
      required: true,
      help:
        "Form CT-W4 line 1. Codes A, B, C, D and F select Tables A–E. Code E stops "
        + "withholding. A missing code is not a completed CT-W4 — Circular CT then "
        + "requires 6.99% with no exemption.",
    },
    {
      key: "additional_per_period",
      label: "Line 2 — Additional withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Added AFTER the calculation rules and AFTER de-annualizing. TPG-211 Step 14.",
    },
    {
      key: "reduced_per_period",
      label: "Line 3 — Reduced withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Subtracted AFTER the calculation rules. TPG-211 Step 15: the amount cannot "
        + "exceed the withholding computed at Step 13. The result cannot be less than zero.",
    },
  ],
};

export const CT_REGION: PayrollRegionWithholding = {
  region: "CT",
  label: "Connecticut income tax",
  implemented: true,
  // Circular CT: wages for services performed in Connecticut are subject to
  // withholding. Form CT-W4NA apportions a nonresident who works partly
  // outside Connecticut — that apportionment is not implemented here, so a
  // Connecticut-source wage is withheld in full rather than guessed at 60%.
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by TPG-211: whether a Connecticut resident's wages earned
  // entirely outside Connecticut must be withheld on. Declared unknown.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ct_ctw4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "TPG-211, 2026 Withholding Calculation Rules (Rev. 12/25); Informational Publication "
    + "2026(1), Connecticut Employer's Tax Guide, Circular CT; Form CT-W4 (Rev. 12/25)",
};
