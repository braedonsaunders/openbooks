/**
 * Delaware withholding declarations — W-4 / SD/W-4A answers and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/**
 * Delaware withholding answers. The Division of Revenue does not require a
 * state-only form: "An employer may rely upon the number of Federal withholding
 * exemptions claimed by the employee." Form SD/W-4A is an optional worksheet
 * "not required of Delaware wage earners; nor is it required to be in files of
 * employers." These fields store the Delaware-purpose status and allowances
 * the employer actually uses.
 */
export const DE_CERTIFICATE: PayrollCertificate = {
  key: "us_de_sdw4a",
  form: "W-4 / SD/W-4A",
  label: "Delaware withholding (W-4 or SD/W-4A)",
  scope: { level: "region", region: "DE" },
  purpose: "withholding",
  citation:
    "Delaware Division of Revenue, Employer's Guide (Withholding Regulations and "
    + "Employer's Duties), Section 15 and Section 17; revenue.delaware.gov/"
    + "employers-guide-withholding-regulations-employers-duties/",
  summary:
    "Sets Delaware filing status and personal exemptions for the annualized "
    + "method. \"If an employee fails to furnish a certificate, you must withhold "
    + "tax as if the employee is a single person who has no withholding allowances.\"",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Filing status (standard deduction)",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single — $3,250 standard deduction" },
        { value: "married_joint", label: "Married filing jointly — $6,500 standard deduction" },
        { value: "married_separate", label: "Married filing separately — $3,250 standard deduction" },
      ],
      help:
        "Section 17 Step 2. Default Single is the publication's own rule when no "
        + "certificate is on file, not an engine guess.",
    },
    {
      key: "allowances",
      label: "Personal exemptions (Delaware purposes)",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each exemption is a $110 annual credit subtracted AFTER the tax (Section 17 "
        + "Steps 5–6). Default zero: no certificate means a single person with no "
        + "allowances. Post-2020 federal Form W-4 has no allowance count — enter the "
        + "Delaware-purpose number, do not invent one from dependents.",
    },
    {
      key: "additional_per_period",
      label: "Additional withholding per pay period (written agreement)",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Section 17: additional amounts may be withheld under a written agreement. "
        + "Added AFTER the annualized method is de-annualized.",
    },
    {
      key: "exempt",
      label: "Exempt from Delaware withholding",
      kind: "flag",
      help:
        "Section 15(b): an exempt certificate is honored unless the Division later "
        + "notifies the employer it is defective. A current exempt flag withholds zero.",
    },
  ],
};

export const DE_REGION: PayrollRegionWithholding = {
  region: "DE",
  label: "Delaware income tax",
  implemented: true,
  // Section 1: withhold from residents or non-residents whose wages are
  // taxable in Delaware. Section 16's W-4NR proration is not implemented —
  // a Delaware-source wage is withheld under the resident annualized method
  // rather than guessed at a source fraction.
  taxesNonresidentWages: true,
  // Section 1 reaches residents. A resident working entirely outside Delaware
  // is not given a credit-offset formula in Section 17. Declared unknown.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_de_sdw4a",
  // Wilmington's city wage tax is a separate levy this pack has not
  // transcribed a rate for. No sub-region, no invented 1.25%.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Delaware Division of Revenue, Employer's Guide, Section 17 Withholding Methods "
    + "Based on Annualized Wages, Tax Computation Table Effective January 1, 2025; "
    + "Section 15 Withholding Exemption and Allowances",
};
