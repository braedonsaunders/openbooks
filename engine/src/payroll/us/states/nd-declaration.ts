/**
 * North Dakota withholding declarations — federal Form W-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/**
 * North Dakota publishes no state withholding certificate. The 2026 booklet
 * withholds from the federal Form W-4. Section 2 (2020 and after) is the
 * automated-payroll method this pack computes.
 */
export const ND_CERTIFICATE: PayrollCertificate = {
  key: "us_nd_w4",
  form: "W-4",
  label: "Federal Form W-4 (North Dakota withholding)",
  scope: { level: "region", region: "ND" },
  purpose: "withholding",
  citation:
    "North Dakota Office of State Tax Commissioner, Income Tax Withholding "
    + "Rates and Instructions for wages paid in 2026 — Section 2; federal Form W-4",
  summary:
    "North Dakota has no state W-4. Section 2 withholds from the federal W-4 "
    + "Step 1(c) filing status. A newly hired employee who has not submitted "
    + "a W-4 is treated as single.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Federal W-4 Step 1(c) — Filing status",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single or married filing separately" },
        { value: "married_joint", label: "Married filing jointly" },
        { value: "head_household", label: "Head of household" },
      ],
      help:
        "The filing status checked on Form W-4 Step 1(c). Section 2 prints "
        + "a separate Annual Percentage Method Table for each. Default Single "
        + "is the booklet's own rule when no W-4 is on file.",
    },
    {
      key: "additional_per_period",
      label: "Additional North Dakota withholding each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "The booklet asks the employer to accommodate an employee's request "
        + "for additional North Dakota withholding. Added AFTER the period "
        + "amount is rounded to the nearest whole dollar.",
    },
    {
      key: "exempt",
      label: "Exempt from North Dakota withholding",
      kind: "flag",
      help:
        "A current exempt claim withholds zero. North Dakota publishes no "
        + "separate exemption form; dating any lapse is certificate "
        + "administration.",
    },
  ],
};

export const ND_REGION: PayrollRegionWithholding = {
  region: "ND",
  label: "North Dakota income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_nd_w4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "North Dakota Office of State Tax Commissioner, Income Tax Withholding "
    + "Rates and Instructions for wages paid in 2026; federal Form W-4",
};
