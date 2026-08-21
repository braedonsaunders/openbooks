import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Colorado Form DR 0004 — optional. Absent, DR 1098 uses the federal W-4 status. */
export const CO_CERTIFICATE: PayrollCertificate = {
  key: "us_co_dr0004",
  form: "DR 0004",
  label: "Colorado Employee Withholding Certificate",
  scope: { level: "region", region: "CO" },
  purpose: "withholding",
  citation:
    "Colorado Form DR 0004; DR 1098 (rev. 11/14/23) lines 2a and 2e; "
    + "tax.colorado.gov/withholding-FAQ",
  summary:
    "Optional Colorado certificate. When it is not on file, DR 1098 calculates from the "
    + "employee's federal W-4 Step 1(c) filing status and withholds no extra amount.",
  storage: "certificate_rows",
  fields: [
    {
      key: "annual_allowance",
      label: "Line 2 — Annual withholding allowance",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "If filled, this is DR 1098 line 2a in full. If blank — or no DR 0004 is on file — "
        + "line 2a is $10,000 for married filing jointly or qualifying surviving spouse, "
        + "and $5,000 otherwise, exactly as the 11/14/23 worksheet prints.",
    },
    {
      key: "filing_status",
      label: "Federal W-4 Step 1(c) filing status (used when line 2 is blank)",
      kind: "choice",
      default: "other",
      choices: [
        { value: "married_joint", label: "Married filing jointly" },
        { value: "surviving_spouse", label: "Qualifying surviving spouse" },
        { value: "other", label: "Single, married filing separately, or head of household" },
      ],
      help:
        "DR 1098 line 2a reads the federal W-4 when DR 0004 line 2 is blank. The default "
        + "is the $5,000 'otherwise' bucket — the worksheet's own fallback, not a guess.",
    },
    {
      key: "additional_per_period",
      label: "Line 3 — Additional Colorado withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Added after the 4.40% calculation (DR 1098 line 2e). A pre-2022 extra-withholding "
        + "request stays in force until the employee files a new certificate.",
    },
  ],
};

export const CO_REGION: PayrollRegionWithholding = {
  region: "CO",
  label: "Colorado income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // tax.colorado.gov/withholding-tax-filing-requirements: withhold if the
  // employee is a Colorado resident (working anywhere) or a nonresident
  // performing services in Colorado. The out-of-state resident credit is not
  // modelled here, so residence-side withholding stays declared-not-implemented.
  residentWithholding: "required",
  residentWithholdingImplemented: false,
  certificateKey: "us_co_dr0004",
  subRegions: [],
  subRegionConflictRule: "both",
  citation: "DR 1098 (rev. 11/14/23); Colorado withholding tax filing requirements",
};
