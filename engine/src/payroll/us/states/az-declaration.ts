import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Arizona Form A-4, Employee's Arizona Withholding Election 2026. */
export const AZ_CERTIFICATE: PayrollCertificate = {
  key: "us_az_a4",
  form: "A-4",
  label: "Employee's Arizona Withholding Election",
  scope: { level: "region", region: "AZ" },
  purpose: "withholding",
  citation:
    "Arizona Form A-4, Employee's Arizona Withholding Election 2026 (published 01/01/2026); "
    + "A.R.S. § 43-401(E); azdor.gov/business/withholding-tax",
  summary:
    "Elects an Arizona withholding percent of gross taxable wages. If no A-4 is on file "
    + "within five days of hire, A.R.S. § 43-401(E) and ADOR require the employer to "
    + "withhold 2.0%.",
  storage: "certificate_rows",
  fields: [
    {
      key: "withholding_percent",
      label: "Line 1 — Arizona withholding percentage",
      kind: "choice",
      choices: [
        { value: "0.5", label: "0.5%" },
        { value: "1.0", label: "1.0%" },
        { value: "1.5", label: "1.5%" },
        { value: "2.0", label: "2.0%" },
        { value: "2.5", label: "2.5%" },
        { value: "3.0", label: "3.0%" },
        { value: "3.5", label: "3.5%" },
      ],
      default: "2.0",
      required: true,
      help:
        "A percent of GROSS TAXABLE WAGES, not of federal withholding. Form A-4 2026 "
        + "line 1. Default 2.0% is ADOR's prescribed rate when no A-4 is on file — not "
        + "an engine guess.",
    },
    {
      key: "additional_per_period",
      label: "Line 1 — Extra amount to be withheld from each paycheck",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Optional extra dollars after the elected percent. Added, not multiplied.",
    },
    {
      key: "zero_percent",
      label:
        "Line 2 — I elect an Arizona withholding percentage of zero (no Arizona tax liability)",
      kind: "flag",
      help:
        "The employee certifies they expect no Arizona tax liability for the current "
        + "taxable year. Must be renewed each year. The employer withholds nothing.",
    },
  ],
};

export const AZ_REGION: PayrollRegionWithholding = {
  region: "AZ",
  label: "Arizona income tax",
  implemented: true,
  // A.R.S. § 43-401(A): withhold from compensation "for services performed
  // within this state".
  taxesNonresidentWages: true,
  // Form A-4V is a VOLUNTARY request for an Arizona resident employed outside
  // Arizona. Withholding on out-of-state wages of a resident is not required.
  residentWithholding: "not_required",
  residentWithholdingImplemented: true,
  certificateKey: "us_az_a4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Arizona Form A-4 (2026); A.R.S. § 43-401; azdor.gov/business/withholding-tax",
};
