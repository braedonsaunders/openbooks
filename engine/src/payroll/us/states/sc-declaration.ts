/**
 * South Carolina withholding declarations — Form SC W-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form SC W-4, South Carolina Employee's Withholding Allowance Certificate (2026). */
export const SC_CERTIFICATE: PayrollCertificate = {
  key: "us_sc_scw4",
  form: "SC W-4",
  label: "South Carolina Employee's Withholding Allowance Certificate",
  scope: { level: "region", region: "SC" },
  purpose: "withholding",
  citation:
    "South Carolina Department of Revenue, WH-1603F, 2026 SC Withholding Tax Formula; "
    + "Form SC W-4 (2026); WH-105 Withholding Tax Information Guide; SCDOR Withholding FAQs",
  summary:
    "Sets South Carolina allowances and extra withholding. If a new employee does "
    + "not provide an SC W-4, SCDOR requires the employer to withhold at zero allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "allowances",
      label: "Line 5 — Total number of allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each allowance is $5,000 a year. Zero allowances also forces the standard "
        + "deduction to $0. Default zero is SCDOR's own rule when no SC W-4 is on file.",
    },
    {
      key: "additional_per_period",
      label: "Line 6 — Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help: "Added AFTER WH-1603F is de-annualized. A flat dollar amount.",
    },
    {
      key: "exempt",
      label: "Line 7 — Exempt from South Carolina withholding",
      kind: "flag",
      help:
        "Expires December 31 of the year claimed. A current Exempt on line 7 "
        + "withholds zero. Dating the year-end lapse is certificate administration.",
    },
  ],
};

export const SC_REGION: PayrollRegionWithholding = {
  region: "SC",
  label: "South Carolina income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_sc_scw4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "SCDOR WH-1603F, 2026 SC Withholding Tax Formula; Form SC W-4 (2026); WH-105",
};
