/**
 * Maryland withholding declarations — Form MW507, the 24-county region,
 * and the MW507 reciprocity claim.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module
 * from the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollReciprocityAgreement } from "../../reciprocity.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import { MD_COUNTIES_2026 } from "./md.ts";

/** Form MW507, Employee's Maryland Withholding Exemption Certificate (COM/RAD-036 07/25). */
export const MD_CERTIFICATE: PayrollCertificate = {
  key: "us_md_mw507",
  form: "MW507",
  label: "Employee's Maryland Withholding Exemption Certificate",
  scope: { level: "region", region: "MD" },
  purpose: "withholding",
  citation:
    "Maryland Form MW507 (COM/RAD-036 07/25); 2026 Maryland Employer Withholding Guide, "
    + "Revised December 2025; Withholding Tax Facts January 2026–December 2026 "
    + "(COM/RAD-098 Revised 12/25)",
  summary:
    "Sets Maryland state and local withholding. If the employee does not furnish MW507, "
    + "the employer withholds as if one exemption was claimed. County of residence "
    + "selects the local rate; a blank county is refused, not defaulted to 3.30%.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Filing status (MW507 status checkboxes)",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single" },
        {
          value: "married_joint_hoh",
          label: "Married (surviving spouse or unmarried Head of Household) Rate",
        },
        { value: "married_single_rate", label: "Married, but withhold at Single rate" },
      ],
      help:
        "The Guide's SINGLE schedule is for Single, Married Filing Separately, a dependent "
        + "taxpayer, or this form's \"Married, but withhold at Single rate\" box. The JOINT "
        + "schedule is the middle box — married filing jointly, head of household, or "
        + "qualifying surviving spouse. Default Single: the form's first box, and the "
        + "Guide does not name a joint default when no certificate is on file.",
    },
    {
      key: "exemptions",
      label: "Line 1 — Total number of exemptions",
      kind: "count",
      min: "0", max: "99", default: "1",
      help:
        "MW507 line 1, not more than worksheet line f. Each exemption is worth $3,200 a "
        + "year in the percentage method. Default ONE: \"If an employee fails to furnish a "
        + "certificate, the employer is required to withhold the tax as if the employee "
        + "had claimed one withholding exemption.\"",
    },
    {
      key: "additional_per_period",
      label: "Line 2 — Additional withholding per pay period under agreement with employer",
      kind: "amount", decimals: 4, min: "0",
      help:
        "Added AFTER the percentage-method combined state+local tax — a flat dollar "
        + "amount the employee and employer have agreed, not a taxable-wage adjustment.",
    },
    {
      key: "residence_county",
      label: "County of residence (nonresidents: Maryland county of employment)",
      kind: "code",
      subRegion: { side: "residence" },
      help:
        "The two-digit Comptroller county code (01–24) or the two-letter pay-stub code. "
        + "Local tax follows the county of residence; a nonresident enters the Maryland "
        + "county where they work. Anne Arundel (02) and Frederick (11) use the Guide's "
        + "graduated local rates, not a single table. A blank county is refused.",
    },
    {
      key: "exempt",
      label: "Line 3 — Exempt because no Maryland tax is expected",
      kind: "flag",
      help:
        "Both of line 3's boxes: no Maryland income tax last year with a right to a full "
        + "refund of everything withheld, AND none expected this year. Seasonal and "
        + "student employees below the filing threshold use this line. A new MW507 is "
        + "due by February 15 to keep the claim.",
    },
    {
      key: "reciprocal_exempt",
      label: "Line 4 — Domiciled in the District of Columbia, Virginia or West Virginia",
      kind: "flag",
      help:
        "MW507 line 4: the employee is domiciled in DC, Virginia or West Virginia and "
        + "does not maintain a place of abode in Maryland for 183 days or more. The "
        + "Guide then makes no Maryland withholding. Pennsylvania is NOT this line — "
        + "use lines 5–7. The matching non-residence certificate is us_md_mw507_nr.",
    },
    {
      key: "pa_state_exempt",
      label: "Line 5 — Domiciled in Pennsylvania (state withholding only)",
      kind: "flag",
      help:
        "MW507 line 5: a Pennsylvania domiciliary who does not maintain a Maryland "
        + "place of abode for 183 days or more is exempt from the STATE portion only. "
        + "Local tax is still withheld at the Maryland county of employment unless "
        + "line 6 or line 7 also applies. This is not a full reciprocal wipe.",
    },
    {
      key: "pa_york_adams_local_exempt",
      label: "Line 6 — Pennsylvania resident of York or Adams County (local too)",
      kind: "flag",
      help:
        "MW507 line 6: lives in a local Pennsylvania jurisdiction within York or Adams "
        + "County and claims exemption from Maryland local tax as well. Enter EXEMPT "
        + "on line 4 of the paper form. Withholding stops completely.",
    },
    {
      key: "pa_other_local_exempt",
      label: "Line 7 — Other Pennsylvania locality that does not tax Maryland residents",
      kind: "flag",
      help:
        "MW507 line 7: lives in a local Pennsylvania jurisdiction that does not impose "
        + "an earnings or income tax on Maryland residents, and claims exemption from "
        + "Maryland local tax as well. Enter EXEMPT on line 4 of the paper form.",
    },
    {
      key: "military_spouse_exempt",
      label: "Line 8 — Military spouse (SCRA / MSRRA)",
      kind: "flag",
      help:
        "The employee is in Maryland solely to be with a servicemember spouse stationed "
        + "here under orders and maintains a domicile in another state. Attach Form "
        + "MW507M and a copy of the spousal military identification card.",
    },
  ],
};

/**
 * MW507 lines 4's reciprocity claim, as a non-residence certificate.
 *
 * The Guide (p. 5) requires Form MW507 itself: the employee certifies
 * residence in a reciprocal jurisdiction listed on the form. Line 4 lists
 * the District of Columbia, Virginia and West Virginia — full exemption
 * from Maryland withholding. Pennsylvania is lines 5–7 on the withholding
 * certificate (state-only, local remains unless 6/7) and is NOT a row
 * here: treating PA as a full reciprocal wipe would drop the local tax
 * the form says is still due.
 */
export const MD_MW507_NR: PayrollCertificate = {
  key: "us_md_mw507_nr",
  form: "MW507",
  label: "Employee's Maryland Withholding Exemption Certificate — reciprocal nonresidence",
  scope: { level: "region", region: "MD" },
  purpose: "non_residence",
  citation:
    "Maryland Form MW507 (COM/RAD-036 07/25) line 4; 2026 Maryland Employer Withholding "
    + "Guide, Revised December 2025 p. 5",
  summary:
    "Claims exemption from Maryland withholding because the employee is domiciled in "
    + "the District of Columbia, Virginia or West Virginia and does not maintain a "
    + "Maryland place of abode for 183 days or more. Must be on file — the Guide "
    + "does not apply the agreement from residence alone.",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state",
      label: "Line 4 — I am domiciled in",
      kind: "choice",
      required: true,
      choices: [
        { value: "DC", label: "District of Columbia" },
        { value: "VA", label: "Virginia" },
        { value: "WV", label: "West Virginia" },
      ],
      help:
        "MW507 line 4's three reciprocal jurisdictions. Pennsylvania is not listed "
        + "here: line 5 exempts only Maryland STATE tax and leaves local tax in force "
        + "unless line 6 or 7 is also completed.",
    },
  ],
};

/**
 * Directional agreements the parent spreads into `US_RECIPROCITY`.
 *
 * Only the full-exemption partners MW507 line 4 names. Pennsylvania is
 * omitted on purpose — see MD_MW507_NR.
 */
export const MD_RECIPROCITY_AGREEMENTS: readonly PayrollReciprocityAgreement[] = (
  ["DC", "VA", "WV"] as const
).map((residence) => ({
  workRegion: "MD",
  residenceRegion: residence,
  taxedBy: "residence" as const,
  certificateKey: "us_md_mw507_nr",
  // Guide p. 5: MW507 must be filed certifying residence in the
  // reciprocal jurisdiction. Without it, Maryland tax is withheld.
  withoutCertificate: "work_region" as const,
  // Line 4 stops all Maryland withholding, local included.
  relievesSubRegionLevies: true,
  citation:
    "2026 Maryland Employer Withholding Guide, Revised December 2025 p. 5; Form MW507 "
    + `(COM/RAD-036 07/25) line 4 — ${residence} domiciliary`,
}));

const MD_COUNTY_LEVIES = MD_COUNTIES_2026.map((county) => ({
  code: county.code,
  label: `${county.name} local income tax`,
  kind: "county",
  reaches: ["resident", "nonresident"] as const,
  rateSource: { kind: "pack" } as const,
  certificateKey: "us_md_mw507",
  citation:
    `Withholding Tax Facts January 2026–December 2026 (COM/RAD-098 Revised 12/25) — `
    + `${county.name} (code ${county.code})`
    + (county.rate === "graduated"
      ? ", graduated local rates as printed in the 2026 Employer Withholding Guide p. 9"
      : `, actual local rate ${county.rate}%, percentage-method table ${county.tablePercent}%`),
  implemented: true,
}));

export const MD_REGION: PayrollRegionWithholding = {
  region: "MD",
  label: "Maryland income tax",
  implemented: true,
  // Guide p. 4: an employee includes a nonresident who performs any
  // service in Maryland for wages, unless a reciprocal MW507 is on file.
  taxesNonresidentWages: true,
  // Guide p. 4: "A resident of Maryland who performs any service outside
  // this state for wages" is an employee. Residents working in Delaware
  // or another nonreciprocal state use a special credit table (Guide
  // pp. 10–12) this engine does not compute.
  residentWithholding: "required",
  residentWithholdingImplemented: false,
  certificateKey: "us_md_mw507",
  subRegions: MD_COUNTY_LEVIES,
  // Local tax follows the county of residence. A nonresident's MW507
  // county field is the Maryland county of employment — the same
  // certificate answer, not a higher-of comparison.
  subRegionConflictRule: "residence_only",
  citation:
    "Comptroller of Maryland, 2026 Maryland Employer Withholding Guide, Revised "
    + "December 2025; Withholding Tax Facts January 2026–December 2026 "
    + "(COM/RAD-098 Revised 12/25); Form MW507 (COM/RAD-036 07/25)",
};
