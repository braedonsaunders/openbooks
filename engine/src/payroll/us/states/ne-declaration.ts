/**
 * Nebraska withholding declarations — Form W-4N and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form W-4N, Nebraska Withholding Allowance Certificate. */
export const NE_CERTIFICATE: PayrollCertificate = {
  key: "us_ne_w4n",
  form: "W-4N",
  label: "Nebraska Withholding Allowance Certificate",
  scope: { level: "region", region: "NE" },
  purpose: "withholding",
  citation:
    "Nebraska Department of Revenue, Circular EN for wages paid on or after "
    + "January 1, 2026; Form W-4N. A federal Form W-4 on file may be used for "
    + "the same marital status and allowance count.",
  summary:
    "Sets Nebraska marital status and withholding allowances. If the employee "
    + "does not furnish a W-4N or federal W-4, Circular EN requires withholding "
    + "as single with no allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Marital status for Nebraska withholding",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single (including head of household)" },
        { value: "married", label: "Married (including surviving spouse)" },
      ],
      help:
        "Circular EN Table 7 uses Single (including head of household) or "
        + "Married (including surviving spouse). Default Single is the "
        + "publication's own rule when no W-4 / W-4N is on file.",
    },
    {
      key: "allowances",
      label: "Number of Nebraska income tax withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each allowance is $2,440 a year. Default zero is Circular EN's "
        + "missing-form rule (single, no allowance).",
    },
    {
      key: "additional_per_period",
      label: "Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "An employee may request additional Nebraska withholding on Form W-4N. "
        + "Added AFTER the percentage method is de-annualized.",
    },
    {
      key: "exempt",
      label: "Exempt from Nebraska withholding",
      kind: "flag",
      help:
        "A current exempt claim withholds zero. Circular EN warns that the "
        + "1.5% special procedure (employers with more than 24 employees) may "
        + "overrule an exempt claim; that procedure is not applied here "
        + "because this engine does not receive employer headcount.",
    },
  ],
};

export const NE_REGION: PayrollRegionWithholding = {
  region: "NE",
  label: "Nebraska income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ne_w4n",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Nebraska Department of Revenue, Circular EN for wages paid on or after "
    + "January 1, 2026; Form W-4N",
};
