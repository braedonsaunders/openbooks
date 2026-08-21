/**
 * Idaho withholding declarations — Form ID W-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form ID W-4, Employee's Withholding Allowance Certificate. */
export const ID_CERTIFICATE: PayrollCertificate = {
  key: "us_id_idw4",
  form: "ID W-4",
  label: "Idaho Employee's Withholding Allowance Certificate",
  scope: { level: "region", region: "ID" },
  purpose: "withholding",
  citation:
    "Idaho State Tax Commission, Table for Percentage Computation Method of "
    + "Withholding, revised 07-23-2026; Computing Withholding; Form ID W-4 "
    + "(EFO00307 04-28-2025)",
  summary:
    "Sets Idaho withholding status A/B/C, allowances, and extra withholding. "
    + "After the Idaho Child Tax Credit sunset the allowance amount is zero; "
    + "status still selects the Single or Married percentage table.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Withholding status (boxes A / B / C)",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "A — Single (including head of household)" },
        { value: "married", label: "B — Married" },
        {
          value: "married_single_rate",
          label: "C — Married, but withhold at Single rate",
        },
      ],
      help:
        "Status A and C use the Single Persons table. Status B uses the Married "
        + "Persons table. Default Single is the higher-withholding ID W-4 box A.",
    },
    {
      key: "allowances",
      label: "Line 1 — Total number of Idaho allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "After the July 23 2026 sunset the ICTCAT amount is zero, so each "
        + "allowance subtracts $0 from wages. The field is still collected "
        + "because Form ID W-4 line 1 is still filed. Write Exempt instead of "
        + "a count by setting the exempt flag.",
    },
    {
      key: "additional_per_period",
      label: "Line 2 — Additional amount to withhold each paycheck",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Whole dollars on Form ID W-4. Added AFTER the percentage method is "
        + "rounded to the nearest whole dollar.",
    },
    {
      key: "exempt",
      label: "Line 1 — Exempt from Idaho withholding",
      kind: "flag",
      help:
        "Form ID W-4 lets the employee write Exempt on line 1 when last year "
        + "had no Idaho income-tax liability and none is expected this year. "
        + "A current exempt flag withholds zero.",
    },
  ],
};

export const ID_REGION: PayrollRegionWithholding = {
  region: "ID",
  label: "Idaho income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_id_idw4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Idaho State Tax Commission, Table for Percentage Computation Method of "
    + "Withholding, revised 07-23-2026; Form ID W-4",
};
