/**
 * Alabama withholding declarations — Form A-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form A-4, Employee's Withholding Exemption Certificate. */
export const AL_CERTIFICATE: PayrollCertificate = {
  key: "us_al_a4",
  form: "A-4",
  label: "Employee's Withholding Exemption Certificate (Alabama)",
  scope: { level: "region", region: "AL" },
  purpose: "withholding",
  citation:
    "Alabama Department of Revenue, Withholding Tax Tables and Instructions for "
    + "Employers and Withholding Agents, Revised August 2024; Form A-4; Ala. Admin. "
    + "Code r. 810-3-71-.02",
  summary:
    "Sets the Alabama withholding exemption (0, S, MS, M, H) and dependents. "
    + "Federal Form W-4 is not an acceptable substitute. If an employee fails to "
    + "furnish Form A-4, the employer withholds using zero exemptions.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exemption",
      label: "Withholding exemption (Form A-4)",
      kind: "choice",
      default: "0",
      choices: [
        { value: "0", label: "0 — no personal exemption" },
        { value: "S", label: "S — single personal exemption ($1,500)" },
        { value: "MS", label: "MS — married filing separately ($1,500)" },
        { value: "M", label: "M — married filing jointly ($3,000)" },
        { value: "H", label: "H — head of family ($3,000)" },
      ],
      help:
        "Default 0 is ALDOR's own rule when no A-4 is on file. H uses the head-of-family "
        + "standard deduction and the 0/S/MS tax brackets. M is the only status that "
        + "uses the doubled brackets.",
    },
    {
      key: "dependents",
      label: "Dependents other than spouse",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each dependent is $1,000 / $500 / $300 a year depending on annualized GI "
        + "(≤ $50,000 / ≤ $100,000 / above). Not the spouse — M already covers both "
        + "personal exemptions.",
    },
    {
      key: "federal_income_tax_withheld",
      label: "Federal income tax withheld this period (formula line 2B)",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Not an A-4 line. The formula subtracts this period's federal withholding "
        + "annualized. A missing amount is refused — assuming zero would over-withhold. "
        + "Do not include FICA.",
    },
    {
      key: "additional_per_period",
      label: "Additional Alabama withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help: "Added AFTER the formula is de-annualized. A flat dollar amount.",
    },
  ],
};

export const AL_REGION: PayrollRegionWithholding = {
  region: "AL",
  label: "Alabama income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_al_a4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Alabama Department of Revenue, Withholding Tax Tables and Instructions for "
    + "Employers and Withholding Agents, Revised August 2024; Ala. Admin. Code r. 810-3-71-.02",
};
