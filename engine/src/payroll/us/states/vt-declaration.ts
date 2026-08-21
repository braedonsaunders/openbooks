/**
 * Vermont withholding declarations — Form W-4VT and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form W-4VT, Vermont Employee's Withholding Allowance Certificate (2026). */
export const VT_CERTIFICATE: PayrollCertificate = {
  key: "us_vt_w4vt",
  form: "W-4VT",
  label: "Vermont Employee's Withholding Allowance Certificate",
  scope: { level: "region", region: "VT" },
  purpose: "withholding",
  citation:
    "Vermont Department of Taxes, GB-1210, 2026 Income Tax Withholding "
    + "Instructions, Tables, and Charts; Form W-4VT",
  summary:
    "Sets Vermont filing status and allowances. Civil-union partners use the "
    + "Married table. A missing W-4VT is withheld as single with zero allowances. "
    + "Copying a federal W-4 onto this certificate is administration, not an "
    + "engine guess.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Filing status (percentage-method table)",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single" },
        { value: "married", label: "Married or civil union" },
      ],
      help:
        "GB-1210 prints Single and Married tables. Civil-union partners use "
        + "the Married table. Default Single is a missing W-4VT, not an "
        + "engine guess.",
    },
    {
      key: "allowances",
      label: "Number of Vermont withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each weekly allowance is $103.85. The booklet prints the matching "
        + "amount on every other frequency's table. Default zero is a blank "
        + "W-4VT.",
    },
    {
      key: "additional_per_period",
      label: "Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A flat dollar amount requested on Form W-4VT. Added AFTER the "
        + "percentage-method table is applied to this period's wages.",
    },
    {
      key: "exempt",
      label: "Exempt from Vermont withholding",
      kind: "flag",
      help:
        "A current exempt claim on W-4VT withholds zero. Dating any year-end "
        + "lapse is certificate administration.",
    },
  ],
};

export const VT_REGION: PayrollRegionWithholding = {
  region: "VT",
  label: "Vermont income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_vt_w4vt",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Vermont Department of Taxes, GB-1210, 2026 Income Tax Withholding "
    + "Instructions, Tables, and Charts; Form W-4VT",
};
