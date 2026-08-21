/**
 * Kentucky withholding declarations — Form K-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form 42A804 (K-4) (2026). */
export const KY_CERTIFICATE: PayrollCertificate = {
  key: "us_ky_k4",
  form: "K-4",
  label: "Kentucky's Withholding Certificate",
  scope: { level: "region", region: "KY" },
  purpose: "withholding",
  citation:
    "Kentucky Form 42A804 (K-4) (2026); 42A003 (TCF)(10-2025) 2026 Kentucky Withholding Tax Formula",
  summary:
    "Documents an exemption from Kentucky withholding or a request for additional withholding. "
    + "\"If neither situation applies, then an employer is not required to maintain Form K-4.\" "
    + "The formula itself has no allowances — every wage earner is taxed at 3.5% after the "
    + "$3,360 standard deduction.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exempt",
      label: "Exempt from Kentucky withholding",
      kind: "flag",
      help:
        "K-4 boxes 1–4: no 2026 Kentucky income-tax liability expected; Fort Campbell "
        + "nonresident exemption; nonresident military-spouse (SCRA); or resident of a "
        + "reciprocal state (IL, IN, MI, WV, WI; VA with a daily commute; OH if not a "
        + "20%-or-greater S-corporation shareholder-employee). Any one box stops withholding. "
        + "The exemption must be on file before withholding can be stopped.",
    },
    {
      key: "additional_per_period",
      label: "Additional withholding per pay period under agreement with employer",
      kind: "amount", decimals: 4, min: "0",
      help: "Added AFTER the 3.5% formula — a flat dollar amount, not a taxable adjustment.",
    },
  ],
};

export const KY_REGION: PayrollRegionWithholding = {
  region: "KY",
  label: "Kentucky income tax",
  implemented: true,
  // KRS 141 and the Department's employer page: withhold for resident and
  // nonresident employees unless a published exemption applies.
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by 42A003: whether a Kentucky resident's wages earned
  // entirely outside Kentucky must be withheld on. Declared unknown.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ky_k4",
  // Kentucky cities levy occupational-license / payroll taxes that are not
  // the state income tax and are not in 42A003. They are not modelled here.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Kentucky Department of Revenue, 42A003 (TCF)(10-2025), 2026 Kentucky Withholding Tax "
    + "Formula; Form 42A804 (K-4) (2026)",
};
