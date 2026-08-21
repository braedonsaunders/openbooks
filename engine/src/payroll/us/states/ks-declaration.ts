/**
 * Kansas withholding declarations — Form K-4 and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form K-4, Kansas Employee's Withholding Allowance Certificate (Rev. 7-24). */
export const KS_CERTIFICATE: PayrollCertificate = {
  key: "us_ks_k4",
  form: "K-4",
  label: "Kansas Employee's Withholding Allowance Certificate",
  scope: { level: "region", region: "KS" },
  purpose: "withholding",
  citation:
    "Kansas Department of Revenue, KW-100 Withholding Tax Guide (live official); "
    + "Form K-4 (Rev. 7-24)",
  summary:
    "Sets the K-4 allowance rate (Single or Joint) and the total number of "
    + "Kansas withholding allowances. If the employee does not complete a K-4, "
    + "KW-100 requires withholding at the single rate with no allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Line 3 — Allowance rate",
      kind: "choice",
      default: "single",
      choices: [
        {
          value: "single",
          label: "Single (including head of household, or married whose spouse has income)",
        },
        { value: "married", label: "Joint — married and spouse has no income" },
      ],
      help:
        "K-4 Line A / Line 3. Joint uses the Married percentage table and the "
        + "$18,320 personal exemption. Single uses the Single table and the "
        + "$9,160 personal exemption. Default Single is KW-100's missing-form rule.",
    },
    {
      key: "allowances",
      label: "Line 4 — Total number of Kansas withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "From the K-4 Personal Allowance Worksheet line F. Joint treats the "
        + "first two allowances as the $18,320 married-joint exemption; Single "
        + "treats the first as the $9,160 exemption. Each remaining allowance "
        + "is the $2,320 dependent amount. Default zero is KW-100's missing-form rule.",
    },
    {
      key: "additional_per_period",
      label: "Line 5 — Additional amount to withhold each paycheck",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Optional extra Kansas withholding requested on Form K-4. Added AFTER "
        + "the percentage formula. The amounts in KW-100 are the minimum.",
    },
    {
      key: "exempt",
      label: "Line 6 — Exempt from Kansas withholding",
      kind: "flag",
      help:
        "A federal withholding exemption also exempts Kansas withholding. A "
        + "current Exempt on K-4 line 6 withholds zero. Exemption from "
        + "withholding is not an exemption from filing a Kansas return.",
    },
  ],
};

export const KS_REGION: PayrollRegionWithholding = {
  region: "KS",
  label: "Kansas income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ks_k4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Kansas Department of Revenue, KW-100 Withholding Tax Guide (live official); Form K-4",
};
