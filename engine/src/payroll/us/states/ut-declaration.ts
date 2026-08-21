import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/**
 * Utah publishes no state withholding certificate. Publication 14 (Rev. 4/26)
 * p. 3: withhold from the employee's federal Form W-4 filing status and the
 * Utah schedules. The fields below are the W-4 answers Pub 14 actually reads.
 */
export const UT_CERTIFICATE: PayrollCertificate = {
  key: "us_ut_w4",
  form: "W-4",
  label: "Federal Form W-4 (Utah withholding)",
  scope: { level: "region", region: "UT" },
  purpose: "withholding",
  citation:
    "Utah Publication 14 (Rev. 4/26) pp. 3 and 8–12; Publication 14 (Rev. 4/25) pp. 3 and 8–12; "
    + "federal Form W-4",
  summary:
    "Utah has no state W-4. Pub 14 withholds from the federal W-4 filing status and the "
    + "Utah schedules. With no W-4 on file the federal default is Single, which is the "
    + "Single column.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Federal W-4 Step 1(c) — Filing status",
      kind: "choice",
      choices: [
        {
          value: "single",
          label: "Single or married filing separately",
          help: "Pub 14 Single column.",
        },
        {
          value: "married",
          label: "Married filing jointly or qualifying surviving spouse",
          help: "Pub 14 Married column.",
        },
        {
          value: "head_household",
          label: "Head of household",
          help:
            "Pub 14 withholding-tables footnote: \"Use the Single column for taxpayers who "
            + "file as head-of-household on their federal return.\"",
        },
      ],
      default: "single",
      required: true,
      help:
        "The filing status on the employee's federal W-4. Pub 14 prints only Single and "
        + "Married; head of household uses Single. Default Single is the federal W-4 "
        + "default when no certificate is on file.",
    },
    {
      key: "exempt",
      label: "Utah Only — Exempt (interstate transportation or military spouse)",
      kind: "flag",
      help:
        "The employee wrote \"Utah Only - Exempt, Interstate Transportation\" or "
        + "\"Utah Only - Exempt, Military Spouse\" under federal W-4 box 4c. Pub 14 "
        + "pp. 2–3: do not withhold Utah tax.",
    },
  ],
};

export const UT_REGION: PayrollRegionWithholding = {
  region: "UT",
  label: "Utah income tax",
  implemented: true,
  // Pub 14 p. 2: withhold if you "pay wages to any employee for work done in Utah".
  taxesNonresidentWages: true,
  // Pub 14 p. 2: also withhold on "wages to Utah resident employees for work
  // done outside Utah (you may reduce the Utah tax by any tax withheld by the
  // other state)". That offset is not modelled — declared, not approximated.
  residentWithholding: "required_net_of_credit",
  residentWithholdingImplemented: false,
  certificateKey: "us_ut_w4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Utah State Tax Commission, Publication 14, Withholding Tax Guide (Rev. 4/26), "
    + "effective June 1, 2026; Publication 14 (Rev. 4/25) for pay dates before then",
};
