/**
 * Montana withholding declarations — Form MW-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form MW-4, Montana Employee's Withholding and Exemption Certificate. */
export const MT_CERTIFICATE: PayrollCertificate = {
  key: "us_mt_mw4",
  form: "MW-4",
  label: "Montana Employee's Withholding and Exemption Certificate",
  scope: { level: "region", region: "MT" },
  purpose: "withholding",
  citation:
    "Montana Department of Revenue, Employer and Information Agent Guide "
    + "with Montana Withholding Tax Tables – 2026; Form MW-4 (2026)",
  summary:
    "Sets the Montana withholding schedule from MW-4 lines 1a, 1b, 1c, or 2. "
    + "If the employee does not complete an MW-4, the form requires "
    + "withholding using the single filing status on line 1a.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "MW-4 filing status",
      kind: "choice",
      default: "single_or_both",
      choices: [
        {
          value: "single_or_both",
          label: "Line 1a Single / MFS, or line 2 both spouses working",
        },
        {
          value: "married_joint",
          label: "Line 1b Married filing jointly or qualifying surviving spouse",
        },
        { value: "head_household", label: "Line 1c Head of household" },
      ],
      help:
        "Line 1a and line 2 use the same printed tables. Line 2 cuts the "
        + "joint standard deduction and brackets in half because both spouses "
        + "work. Default line 1a is MW-4's own missing-form rule.",
    },
    {
      key: "additional_per_period",
      label: "Line 3 — Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A flat dollar amount requested on Form MW-4 line 3. Added AFTER the "
        + "formula is rounded to the nearest whole dollar.",
    },
    {
      key: "exempt",
      label: "Line 5 — Exempt from Montana withholding",
      kind: "flag",
      help:
        "A current exempt claim on Form MW-4 line 5 withholds zero. Dating "
        + "any year-end lapse is certificate administration.",
    },
  ],
};

export const MT_REGION: PayrollRegionWithholding = {
  region: "MT",
  label: "Montana income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_mt_mw4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Montana Department of Revenue, Employer and Information Agent Guide "
    + "with Montana Withholding Tax Tables – 2026; Form MW-4 (2026)",
};
