/**
 * Louisiana withholding declarations — Form L-4 (R-1300) and the state region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";

/** Form R-1300 (L-4), Employee's Withholding Certificate (1/26). */
export const LA_CERTIFICATE: PayrollCertificate = {
  key: "us_la_l4",
  form: "L-4",
  label: "Louisiana Employee's Withholding Certificate",
  scope: { level: "region", region: "LA" },
  purpose: "withholding",
  citation:
    "Louisiana Department of Revenue, R-1306 (1/26), Louisiana Withholding "
    + "Tables and Formulas; Form R-1300 (L-4) (1/26)",
  summary:
    "Sets the Block A standard-deduction claim (0, 1, or 2). If the employee "
    + "does not complete an L-4, R-1300 requires withholding with no standard "
    + "deduction.",
  storage: "certificate_rows",
  fields: [
    {
      key: "standard_deduction",
      label: "Block A — Standard deduction claimed",
      kind: "choice",
      default: "0",
      choices: [
        { value: "0", label: "0 — No standard deduction" },
        { value: "1", label: "1 — Single or married filing separately ($12,875)" },
        {
          value: "2",
          label: "2 — Married filing jointly, qualifying surviving spouse, or head of household ($25,750)",
        },
      ],
      help:
        "R-1306 formula 1 / 2 / 3. Anyone may use 0 or 1; anyone claiming 2 "
        + "must use the married-joint formula. Default 0 is R-1300's own rule "
        + "when no L-4 is on file — withhold without any standard deduction.",
    },
    {
      key: "additional_per_period",
      label: "L-4 adjustments — Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "An increase in the amount of tax to be withheld, entered on Form L-4. "
        + "Added AFTER the R-1306 computer formula. A decrease is not modeled "
        + "here because R-1306 pins only the formula result.",
    },
  ],
};

export const LA_REGION: PayrollRegionWithholding = {
  region: "LA",
  label: "Louisiana income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_la_l4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Louisiana Department of Revenue, R-1306 (1/26); Form R-1300 (L-4) (1/26)",
};
