/**
 * Connecticut withholding declarations — Form CT-W4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form CT-W4, Employee's Withholding Certificate (Rev. 12/25). */
export const CT_CERTIFICATE: PayrollCertificate = {
  key: "us_ct_ctw4",
  form: "CT-W4",
  label: "Employee's Withholding Certificate (Connecticut)",
  scope: { level: "region", region: "CT" },
  purpose: "withholding",
  citation:
    "Connecticut Form CT-W4 (Rev. 12/25); TPG-211, 2026 Withholding Calculation Rules "
    + "(Rev. 12/25); Informational Publication 2026(1), Connecticut Employer's Tax Guide, "
    + "Circular CT, Issued 12/12/2025",
  summary:
    "Sets the Connecticut withholding code (A, B, C, D, E, or F) and optional extra or "
    + "reduced withholding. \"If an employee fails to give you a completed Form CT-W4, "
    + "you must withhold at a flat rate of 6.99%, without allowance for exemption.\"",
  storage: "certificate_rows",
  fields: [
    {
      key: "withholding_code",
      label: "Line 1 — Withholding Code",
      kind: "choice",
      choices: [
        {
          value: "A",
          label:
            "A — Married filing jointly (spouse employed, combined income $24,000–$100,500) "
            + "or married filing separately",
        },
        { value: "B", label: "B — Head of household" },
        {
          value: "C",
          label:
            "C — Married filing jointly (spouse not employed) or qualifying surviving spouse",
        },
        {
          value: "D",
          label: "D — Highest withholding (no personal exemption and no personal tax credit)",
        },
        {
          value: "E",
          label: "E — Exempt (no Connecticut income-tax liability expected, or MSRRA)",
        },
        { value: "F", label: "F — Single" },
      ],
      required: true,
      help:
        "Form CT-W4 line 1, chosen from the filing-status chart on the form. Codes A, B, C, "
        + "D and F select TPG-211 Tables A–E. Code E stops withholding. A missing code is "
        + "not a completed CT-W4 — Circular CT then requires a flat 6.99% with no exemption.",
    },
    {
      key: "additional_per_period",
      label: "Line 2 — Additional withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Added AFTER the TPG-211 calculation and AFTER de-annualizing (Step 14). A flat "
        + "dollar amount, not a taxable-wage adjustment. Used with Line 3 when IP 2026(7) "
        + "tells a two-earner couple the tables alone will miss.",
    },
    {
      key: "reduced_per_period",
      label: "Line 3 — Reduced withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Subtracted AFTER the calculation rules (TPG-211 Step 15). Circular CT: the Line 3 "
        + "amount cannot exceed the withholding computed at Step 13, and the result cannot "
        + "be less than zero.",
    },
  ],
};

export const CT_REGION: PayrollRegionWithholding = {
  region: "CT",
  label: "Connecticut income tax",
  implemented: true,
  // Circular CT p. 8: wages of a nonresident are subject to withholding if
  // paid for services rendered in Connecticut. Example 10: with no CT-W4NA
  // and no allocation records, withhold as if all services were in Connecticut.
  // Form CT-W4NA's percentage (Examples 8–9) is not a field on CT-W4 and is
  // not applied here — inventing a 60% default would under-withhold.
  taxesNonresidentWages: true,
  // Circular CT pp. 7–8: "All wages of a Connecticut resident are subject to
  // Connecticut income tax withholding even if the resident works outside of
  // Connecticut." When the employer also withholds for the work jurisdiction,
  // Examples 1–4 reduce Connecticut withholding by that other-state tax
  // (prorated when the resident works in more than one qualifying jurisdiction).
  // That offset needs the other jurisdiction's withheld amount, which this
  // engine is not given — declared, never approximated.
  residentWithholding: "required_net_of_credit",
  residentWithholdingImplemented: false,
  certificateKey: "us_ct_ctw4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Informational Publication 2026(1), Connecticut Employer's Tax Guide, Circular CT, "
    + "Issued 12/12/2025, Replaces IP 2025(1); TPG-211, 2026 Withholding Calculation "
    + "Rules (Rev. 12/25); Form CT-W4 (Rev. 12/25)",
};
