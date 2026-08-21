/**
 * Arkansas withholding declarations — Form AR4EC and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form AR4EC, Employee's Withholding Exemption Certificate (2026). */
export const AR_CERTIFICATE: PayrollCertificate = {
  key: "us_ar_ar4ec",
  form: "AR4EC",
  label: "Arkansas Employee's Withholding Exemption Certificate",
  scope: { level: "region", region: "AR" },
  purpose: "withholding",
  citation:
    "Arkansas Department of Finance and Administration, Withholding Tax Formula "
    + "Method, Effective 01/01/2026; Employer's Instructions, Effective 01/01/2026; "
    + "Form AR4EC / AR4ECSP / AR-TX-4EC",
  summary:
    "Sets the number of Arkansas withholding exemptions. A missing AR4EC is "
    + "withheld at zero exemptions (nothing claimed on the certificate). AR4ECSP "
    + "and Texarkana AR-TX-4EC are the exempt paths.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exemptions",
      label: "Withholding exemptions claimed on Form AR4EC",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each exemption is a $29.00 annual personal tax credit subtracted AFTER "
        + "the rounded annual gross tax. Default zero is a blank AR4EC — the "
        + "publication multiplies exemptions claimed, and none claimed is zero.",
    },
    {
      key: "exempt",
      label: "AR4ECSP or AR-TX-4EC — Exempt from Arkansas withholding",
      kind: "flag",
      help:
        "Form AR4ECSP is the special withholding exemption certificate. Form "
        + "AR-TX-4EC is the Texarkana border-city exemption. A current exempt "
        + "flag withholds zero. Dating the year-end lapse of AR-TX-4EC is "
        + "certificate administration.",
    },
  ],
};

export const AR_REGION: PayrollRegionWithholding = {
  region: "AR",
  label: "Arkansas income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ar_ar4ec",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Arkansas DFA, Withholding Tax Formula Method, Effective 01/01/2026; "
    + "Employer's Instructions, Effective 01/01/2026; Form AR4EC",
};
