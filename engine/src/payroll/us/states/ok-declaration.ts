/**
 * Oklahoma withholding declarations — Form OK-W-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form OK-W-4, Oklahoma Employee's Withholding Allowance Certificate. */
export const OK_CERTIFICATE: PayrollCertificate = {
  key: "us_ok_okw4",
  form: "OK-W-4",
  label: "Oklahoma Employee's Withholding Allowance Certificate",
  scope: { level: "region", region: "OK" },
  purpose: "withholding",
  citation:
    "Oklahoma Tax Commission, Packet OW-2 (Revised 11-2025), 2026 Oklahoma "
    + "Income Tax Withholding Tables; Form OK-W-4",
  summary:
    "Sets Oklahoma marital status and the number of $1,000 annual withholding "
    + "allowances. Packet OW-2 requires the number claimed on Form OK-W-4. "
    + "A blank certificate uses Single with zero allowances — the form's own "
    + "empty lines, not an invented higher rate.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Marital status on Form OK-W-4",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single" },
        { value: "married", label: "Married" },
        {
          value: "married_higher_single",
          label: "Married, but withhold at the higher Single rate",
        },
      ],
      help:
        "Packet OW-2 prints Single and Married percentage tables. The "
        + "\"Married, but withhold at higher Single rate\" election uses the "
        + "Single table. Default Single is a blank OK-W-4, not an engine guess.",
    },
    {
      key: "allowances",
      label: "Number of Oklahoma withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each allowance is the printed per-period amount ($41.67 "
        + "semi-monthly, $1,000 annual). Default zero is a blank OK-W-4.",
    },
    {
      key: "additional_per_period",
      label: "Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A flat dollar amount requested on Form OK-W-4. Added AFTER the "
        + "percentage method is rounded to the nearest whole dollar.",
    },
    {
      key: "exempt",
      label: "Exempt from Oklahoma withholding",
      kind: "flag",
      help:
        "A current exempt claim on Form OK-W-4 withholds zero. Dating any "
        + "year-end lapse is certificate administration.",
    },
  ],
};

export const OK_REGION: PayrollRegionWithholding = {
  region: "OK",
  label: "Oklahoma income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ok_okw4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Oklahoma Tax Commission, Packet OW-2 (Revised 11-2025); Form OK-W-4",
};
