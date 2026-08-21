/**
 * Maine withholding declarations — Form W-4ME and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form W-4ME, Employee's Maine Withholding Allowance Certificate (2026). */
export const ME_CERTIFICATE: PayrollCertificate = {
  key: "us_me_w4me",
  form: "W-4ME",
  label: "Employee's Maine Withholding Allowance Certificate",
  scope: { level: "region", region: "ME" },
  purpose: "withholding",
  citation:
    "Maine Revenue Services, Withholding Tables for Individual Income Tax, "
    + "Revised December 2025 (2026 booklet); Form W-4ME (2026); MRS Rule 803",
  summary:
    "Sets Maine marital status and withholding allowances. If the employee "
    + "does not provide a valid W-4ME, MRS requires withholding as single "
    + "with no allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Box 3 — Marital status",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single or head of household, or married withholding at the single rate" },
        { value: "married", label: "Married" },
      ],
      help:
        "Use the married percentage schedule only when Married is checked. "
        + "\"Married, but withholding at higher single rate\" and Single / "
        + "Head of Household both use the single schedule. Default Single is "
        + "MRS's own rule when no valid W-4ME is on file.",
    },
    {
      key: "allowances",
      label: "Total number of Maine withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each allowance is $5,300 a year. Claiming more than the W-4ME "
        + "worksheet allows requires a Personal Withholding Allowance "
        + "Variance Certificate. Default zero is MRS's missing-form rule.",
    },
    {
      key: "additional_per_period",
      label: "Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A flat dollar amount requested on W-4ME. Added AFTER the percentage "
        + "method is de-annualized and rounded to the nearest dollar.",
    },
    {
      key: "exempt",
      label: "Line 6 — Exempt from Maine withholding",
      kind: "flag",
      help:
        "Federal exempt, Form W-4P no-withholding, or resident with no Maine "
        + "liability last year and none expected this year. A current exempt "
        + "flag withholds zero. The resident exemption expires December 31.",
    },
  ],
};

export const ME_REGION: PayrollRegionWithholding = {
  region: "ME",
  label: "Maine income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_me_w4me",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "MRS, Withholding Tables for Individual Income Tax, Revised December 2025; "
    + "Form W-4ME (2026); MRS Rule 803",
};
