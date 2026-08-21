/**
 * Rhode Island withholding declarations — Form RI W-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form RI W-4, Employee's Withholding Allowance Certificate for 2026. */
export const RI_CERTIFICATE: PayrollCertificate = {
  key: "us_ri_riw4",
  form: "RI W-4",
  label: "Rhode Island Employee's Withholding Allowance Certificate",
  scope: { level: "region", region: "RI" },
  purpose: "withholding",
  citation:
    "Rhode Island Division of Taxation, 2026 Employer's Income Tax Withholding "
    + "Tables; Form RI W-4 (2026). Federal Form W-4 can no longer be used for "
    + "Rhode Island withholding.",
  summary:
    "Sets Rhode Island allowances. A missing RI W-4 is withheld at zero "
    + "allowances. Annual wages over $290,800 phase the exemption to zero.",
  storage: "certificate_rows",
  fields: [
    {
      key: "allowances",
      label: "Line 1 — Total number of Rhode Island withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each weekly allowance is $19.23 (the booklet's other frequencies scale "
        + "the same $1,000 annual exemption). Default zero is a blank RI W-4 — "
        + "nothing claimed is zero. Federal Form W-4 is not a substitute.",
    },
    {
      key: "additional_per_period",
      label: "Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A flat dollar amount requested on Form RI W-4. Added AFTER the "
        + "percentage-method table is applied to this period's wages.",
    },
    {
      key: "exempt",
      label: "Line 3 — Exempt or Exempt-MS from Rhode Island withholding",
      kind: "flag",
      help:
        "EXEMPT and EXEMPT-MS on line 3 require a new RI W-4 each year. A "
        + "current exempt flag withholds zero. Dating the year-end lapse is "
        + "certificate administration.",
    },
  ],
};

export const RI_REGION: PayrollRegionWithholding = {
  region: "RI",
  label: "Rhode Island income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ri_riw4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Rhode Island Division of Taxation, 2026 Employer's Income Tax Withholding "
    + "Tables; Form RI W-4 (2026)",
};
