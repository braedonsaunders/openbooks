/**
 * Virginia withholding declarations — Form VA-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form VA-4, Employee's Virginia Income Tax Withholding Exemption Certificate. */
export const VA_CERTIFICATE: PayrollCertificate = {
  key: "us_va_va4",
  form: "VA-4",
  label: "Employee's Virginia Income Tax Withholding Exemption Certificate",
  scope: { level: "region", region: "VA" },
  purpose: "withholding",
  citation:
    "Virginia Form VA-4; Income Tax Withholding Guide for Employers, Rev. 05/25 (2614086), "
    + "Formula for Computing Tax to be Withheld (p. 21)",
  summary:
    "Sets Virginia withholding exemptions. \"If you do not file this form, your employer must "
    + "withhold Virginia income tax as if you had no exemptions.\" Federal Form W-4 may not be "
    + "substituted.",
  storage: "certificate_rows",
  fields: [
    {
      key: "personal_exemptions",
      label: "Line 1(a) — Personal and dependent exemptions (E1)",
      kind: "count",
      min: "0", max: "99", default: "0",
      help:
        "Personal Exemption Worksheet line 4. Worth $930 a year each in the formula. Default "
        + "zero: no VA-4 means no exemptions.",
    },
    {
      key: "age_blind_exemptions",
      label: "Line 1(b) — Age 65 and over & blind exemptions (E2)",
      kind: "count",
      min: "0", max: "99", default: "0",
      help: "Personal Exemption Worksheet line 7. Worth $800 a year each. Default zero.",
    },
    {
      key: "additional_per_period",
      label: "Line 2 — Additional withholding requested",
      kind: "amount", decimals: 4, min: "0",
      help:
        "Only if the employer agrees. Added AFTER the formula — a flat dollar amount, not a "
        + "taxable adjustment.",
    },
    {
      key: "exempt",
      label: "Line 3 — Not subject to Virginia withholding",
      kind: "flag",
      help:
        "No Virginia liability last year and none expected this year; expected Virginia AGI "
        + "below the filing threshold; daily commuter from Kentucky or the District of Columbia; "
        + "or a domiciliary of Maryland, Pennsylvania or West Virginia whose only Virginia-source "
        + "income is wages taxed by the state of domicile. A new VA-4 is due each calendar year "
        + "the exemption is claimed.",
    },
    {
      key: "military_spouse_exempt",
      label: "Line 4 — Military spouse (SCRA / MSRRA)",
      kind: "flag",
      help:
        "The employee is in Virginia solely to be with a servicemember spouse stationed here "
        + "under orders, and maintains a domicile in another state. Attach a copy of the "
        + "spousal military identification card.",
    },
  ],
};

export const VA_REGION: PayrollRegionWithholding = {
  region: "VA",
  label: "Virginia income tax",
  implemented: true,
  // Guide p. 12: withhold from nonresidents on services performed in Virginia
  // unless a reciprocity exemption is on the VA-4.
  taxesNonresidentWages: true,
  // Guide p. 11: "A resident of Virginia who performs or performed services
  // outside Virginia for wages" is an employee subject to withholding.
  residentWithholding: "required",
  // Not implemented: an out-of-state assignment needs a work-state credit
  // rule this engine is not given. Declared and refused, never approximated.
  residentWithholdingImplemented: false,
  certificateKey: "us_va_va4",
  // Virginia publishes no local wage income tax an employer withholds.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Virginia Department of Taxation, Income Tax Withholding Guide for Employers, Rev. 05/25 "
    + "(2614086), Formula Method (p. 21); Form VA-4",
};
