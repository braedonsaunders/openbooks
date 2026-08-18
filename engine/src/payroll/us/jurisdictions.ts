/**
 * The US pack's declarations: the tax certificates it issues, the withholding
 * jurisdictions inside the country, and the reciprocity agreements between
 * them.
 *
 * Authored HERE, in the pack, beside the constants they describe — the same
 * arrangement `us/filings.ts` and `us/rates.ts` already use, and for the same
 * reason. Every generic module (`certificates.ts`, `withholding-jurisdictions.ts`,
 * `reciprocity.ts`, `withholding-resolution.ts`) reads these declarations and
 * contains no state code, no form number and no rate.
 *
 * Everything asserted below is from a publication a research pass actually
 * fetched; where a rule was NOT established, the declaration says `unknown` and
 * the resolver refuses rather than guessing. That is the honest shape and it is
 * why 47 states appear here with `implemented: false` instead of being quietly
 * absent.
 */
import type { PayrollCertificate, PayrollPackCertificates } from "../certificates.ts";
import type { PayrollPackReciprocity } from "../reciprocity.ts";
import type {
  PayrollPackWithholding,
  PayrollRegionWithholding,
} from "../withholding-jurisdictions.ts";
import { NO_WITHHOLDING_STATES, US_STATES } from "./rates.ts";
import { implementedUsStates, usStatePublication } from "./states/index.ts";
import { MI_TAXING_CITIES } from "./states/mi.ts";
import { OH_SCHOOL_DISTRICTS_2026 } from "./states/oh.ts";

// ===========================================================================
// Certificates
// ===========================================================================

/**
 * Form W-4 — the federal certificate.
 *
 * Declared with `storage: "profile_columns"`: every field names the column on
 * `employee_payroll_profiles` that ALREADY holds the answer. Nothing is
 * migrated. The engine, the API and the editor now ask one question — "what did
 * this employee answer on certificate `us_w4`?" — and the fact that these nine
 * answers come from columns while a Californian's six come from a row is a
 * storage detail behind `resolveCertificate`.
 *
 * Leaving the federal columns where they are is the conservative half of this
 * work, deliberately: moving live Pub 15-T inputs to new storage in the same
 * pass that introduces the storage would put the federal conformance goldens at
 * risk to prove a migration rather than a table. The mapping costs nothing and
 * defers the move to a pass whose only job is the move.
 */
const W4: PayrollCertificate = {
  key: "us_w4",
  form: "W-4",
  label: "Employee's Withholding Certificate",
  scope: { level: "country" },
  purpose: "withholding",
  citation: "IRS Form W-4 and Publication 15-T, Worksheet 1A",
  summary:
    "Filed with the employer to set federal income tax withholding. An employee with no W-4 on "
    + "file is withheld as single with no adjustments.",
  storage: "profile_columns",
  fields: [
    {
      key: "filing_status", label: "Step 1(c) — Filing status", kind: "choice",
      choices: [
        { value: "single", label: "Single or married filing separately" },
        { value: "married_joint", label: "Married filing jointly or qualifying surviving spouse" },
        { value: "head_household", label: "Head of household" },
      ],
      default: "single", required: true,
      help: "As checked in Step 1(c) of the employee's Form W-4. With no W-4 on file, withhold as "
        + "single.",
      storage: { kind: "column", column: "filing_status" },
    },
    {
      key: "multiple_jobs", label: "Step 2 — Multiple jobs or spouse works", kind: "flag",
      help: "Checked when the employee holds more than one job, or is married filing jointly and "
        + "their spouse also works. It selects the higher Step 2 Checkbox schedule.",
      storage: { kind: "column", column: "multiple_jobs" },
    },
    {
      key: "dependent_credits", label: "Step 3 — Dependents and other credits", kind: "amount",
      decimals: 4, min: "0",
      help: "The ANNUAL total from Step 3. It reduces the tax computed for the period, not the "
        + "wages.",
      storage: { kind: "column", column: "dependent_credits" },
    },
    {
      key: "other_income_annual", label: "Step 4(a) — Other income", kind: "amount",
      decimals: 4, min: "0",
      help: "Annual income the employee expects that is not from a job and has no withholding — "
        + "interest, dividends, retirement.",
      storage: { kind: "column", column: "other_income_annual" },
    },
    {
      key: "deductions_annual", label: "Step 4(b) — Deductions", kind: "amount",
      decimals: 4, min: "0",
      help: "Annual deductions the employee expects BEYOND the standard deduction.",
      storage: { kind: "column", column: "deductions_annual" },
    },
    {
      key: "additional_per_period", label: "Step 4(c) — Extra withholding", kind: "amount",
      decimals: 4, min: "0",
      help: "An extra amount to withhold from EACH pay period, on top of the computed tax.",
      storage: { kind: "column", column: "additional_tax_per_period" },
    },
    {
      key: "exempt", label: "Exempt from federal withholding", kind: "flag",
      help: "The employee wrote \"Exempt\" below Step 4(c). No federal income tax is withheld; "
        + "Social Security and Medicare still are.",
      storage: { kind: "column", column: "tax_exempt" },
    },
    {
      key: "pre_2020", label: "2019-or-earlier W-4 on file", kind: "flag",
      help: "The employee has never filed a redesigned W-4. Withholding uses allowances instead "
        + "of Steps 2-4.",
      storage: { kind: "column", column: "w4_pre_2020" },
    },
    {
      key: "allowances", label: "Withholding allowances (2019-or-earlier W-4)", kind: "count",
      min: "0", max: "99",
      help: "Line 5 of a 2019-or-earlier Form W-4. Only read when that box is set.",
      storage: { kind: "column", column: "w4_allowances" },
    },
  ],
};

/** California Form DE 4 — EDD, Rev. 56 (1-26). */
const CA_DE4: PayrollCertificate = {
  key: "us_ca_de4",
  form: "DE 4",
  label: "Employee's Withholding Allowance Certificate (California)",
  scope: { level: "region", region: "CA" },
  purpose: "withholding",
  citation: "California EDD Form DE 4, Rev. 56 (1-26); California Withholding Schedules 2026, Method B",
  summary:
    "Since 2020 the federal W-4 sets federal withholding only — California requires its own DE 4. "
    + "With no DE 4 on file the employer must withhold at single with zero allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status", label: "Filing status", kind: "choice",
      choices: [
        { value: "single_or_dual", label: "Single, or married with two or more incomes" },
        { value: "married_one_income", label: "Married (one income)" },
        { value: "head_household", label: "Head of household" },
      ],
      default: "single_or_dual", required: true,
      help: "The three checkboxes on the DE 4. \"Single or Married (with two or more incomes)\" is "
        + "the default the EDD requires when no DE 4 has been filed.",
    },
    {
      key: "regular_allowances", label: "Line 1a — Regular withholding allowances", kind: "count",
      min: "0", max: "99", default: "0",
      help: "From Worksheet A. These give a per-period tax CREDIT (Method B, Table 4) — they do "
        + "not reduce wages.",
    },
    {
      key: "estimated_deduction_allowances",
      label: "Line 1b — Estimated deduction allowances", kind: "count",
      min: "0", max: "99", default: "0",
      help: "From Worksheet B: one allowance per $1,000 of deductions above the standard "
        + "deduction. These reduce WAGES (Method B, Table 2) and must not be counted again in the "
        + "Table 4 credit.",
    },
    {
      key: "additional_per_period", label: "Line 2 — Additional amount per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "From Worksheet C. Withheld on top of the computed tax, if the employer agrees.",
    },
    {
      key: "exempt", label: "Line 3 — Exempt for the year", kind: "flag",
      help: "The employee owed no federal or California income tax last year and expects to owe "
        + "none this year. A new exempt DE 4 is due by 15 February each year.",
    },
    {
      key: "military_spouse_exempt", label: "Line 4 — Military spouse (MSRRA)", kind: "flag",
      help: "The employee certifies they are not subject to California withholding under the "
        + "Servicemembers Civil Relief Act as amended by the Military Spouses Residency Relief Act.",
    },
  ],
};

/** New York Form IT-2104 — one form, three jurisdictions. */
const NY_IT2104: PayrollCertificate = {
  key: "us_ny_it2104",
  form: "IT-2104",
  label: "Employee's Withholding Allowance Certificate (New York State, City, Yonkers)",
  scope: { level: "region", region: "NY" },
  purpose: "withholding",
  citation: "NYS Form IT-2104 (2026) and IT-2104-I (2026); NYS-50-T-NYS/NYC/Y (1/26)",
  summary:
    "One certificate covering New York State, New York City and Yonkers. It carries TWO allowance "
    + "counts (state-and-Yonkers, and city) and THREE additional-amount fields.",
  storage: "certificate_rows",
  fields: [
    // The two questions the form asks ABOVE the allowance lines, in the
    // employee-information block: "Are you a resident of New York City?" and
    // "Are you a resident of Yonkers?". They are what puts an employee inside a
    // sub-region levy — the address fact `resolveWithholding` cannot derive and
    // takes from its caller. New York City reaches RESIDENTS ONLY, so without
    // this answer a city resident's city tax is silently zero.
    {
      key: "nyc_resident", label: "Are you a resident of New York City?", kind: "flag",
      subRegion: { side: "residence", code: "NYC" },
      help: "The New York City resident income tax reaches residents only, and it reaches all "
        + "their wages \"even though the services may have been performed outside New York City\". "
        + "A commuter INTO the city owes it nothing — there has been no city nonresident earnings "
        + "tax since 1999.",
    },
    {
      key: "yonkers_resident", label: "Are you a resident of Yonkers?", kind: "flag",
      subRegion: { side: "residence", code: "YONKERS" },
      help: "A Yonkers RESIDENT is withheld a surcharge of 16.75% of the New York State tax. A "
        + "nonresident who WORKS in Yonkers is withheld the separate 0.50% earnings tax instead — "
        + "that one follows the work location, which this answer does not record.",
    },
    {
      key: "filing_status", label: "Filing status", kind: "choice",
      choices: [
        { value: "single_or_hoh", label: "Single or head of household" },
        { value: "married", label: "Married" },
        {
          value: "married_higher_single", label: "Married, but withhold at higher single rate",
          help: "Withheld from the Single schedule.",
        },
      ],
      default: "single_or_hoh", required: true,
      help: "If married but legally separated, choose Single or head of household.",
    },
    {
      key: "nys_allowances", label: "Line 1 — New York State and Yonkers allowances",
      kind: "count", min: "0", max: "99", default: "0",
      help: "One number serves BOTH the state and Yonkers — the Yonkers tax is a percentage of the "
        + "state tax, so it inherits the state's allowances. With no IT-2104 on file and a 2020-"
        + "or-later federal W-4, use zero.",
    },
    {
      key: "nyc_allowances", label: "Line 2 — New York City allowances",
      kind: "count", min: "0", max: "99", default: "0",
      help: "A SEPARATE count from line 1: the city worksheet excludes several state-only credits. "
        + "Only used if the employee is a New York City resident.",
    },
    {
      key: "nys_additional", label: "Line 3 — Additional New York State amount",
      kind: "amount", decimals: 4, min: "0",
      help: "Extra state tax per pay period, by arrangement with the employer.",
    },
    {
      key: "nyc_additional", label: "Line 4 — Additional New York City amount",
      kind: "amount", decimals: 4, min: "0",
      help: "Extra city tax per pay period.",
    },
    {
      key: "yonkers_additional", label: "Line 5 — Additional Yonkers amount",
      kind: "amount", decimals: 4, min: "0",
      help: "Extra Yonkers tax per pay period.",
    },
  ],
};

/** New York Form IT-2104.1 — the non-residence certificate. */
const NY_IT2104_1: PayrollCertificate = {
  key: "us_ny_it2104_1",
  form: "IT-2104.1",
  label: "Certificate of Nonresidence and Allocation of Withholding Tax (New York)",
  scope: { level: "region", region: "NY" },
  purpose: "non_residence",
  citation: "NYS Form IT-2104.1 (12/24); Publication NYS-50 (12/23) part K",
  summary:
    "Certifies the employee is not a resident of New York State, New York City or Yonkers, and "
    + "estimates the percentage of services performed in New York. It does NOT relieve New York "
    + "tax on New York-source wages — New York has no reciprocity — it allocates them.",
  storage: "certificate_rows",
  fields: [
    {
      key: "not_nys_resident", label: "Part 1 — Not a New York State resident", kind: "flag",
      help: "The employee certifies their residence is outside New York State.",
    },
    {
      key: "nys_service_percent", label: "Part 1 — Percent of services in New York State",
      kind: "amount", decimals: 4, min: "0", max: "100",
      help: "The employer may not accept a zero percent allocation if ANY part of the employee's "
        + "compensation is for services performed in New York State.",
    },
    {
      key: "not_nyc_resident", label: "Part 2 — Not a New York City resident", kind: "flag",
      help: "New York City taxes residents only, so this is the whole of Part 2 — there is no "
        + "percentage, because a nonresident owes no city tax at all.",
    },
    {
      key: "not_yonkers_resident", label: "Part 3 — Not a Yonkers resident", kind: "flag",
      help: "A Yonkers nonresident still owes the Yonkers NONRESIDENT earnings tax on "
        + "Yonkers-source wages.",
    },
    {
      key: "yonkers_service_percent", label: "Part 3 — Percent of services in Yonkers",
      kind: "amount", decimals: 4, min: "0", max: "100",
      help: "Drives the Yonkers nonresident earnings tax base.",
    },
  ],
};

/** Illinois Form IL-W-4. */
const IL_W4: PayrollCertificate = {
  key: "us_il_ilw4",
  form: "IL-W-4",
  label: "Employee's Illinois Withholding Allowance Certificate",
  scope: { level: "region", region: "IL" },
  purpose: "withholding",
  citation: "Illinois Form IL-W-4 (R-07/23); Booklet IL-700-T (R-12/25); Publication 130 (R-02/26)",
  summary:
    "Sets Illinois withholding allowances. If no completed IL-W-4 is on file — or it is unsigned, "
    + "incomplete or altered — the employer must withhold on the entire compensation with NO "
    + "allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "line1_allowances", label: "Line 1 — Basic allowances", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Worth $2,925 a year each in 2026. Default zero: Publication 130 requires withholding "
        + "with no allowances when no valid certificate is on file.",
    },
    {
      key: "line2_allowances", label: "Line 2 — Additional allowances", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Worth $1,000 a year each. Claimed for age 65 or over and blindness, AND for each "
        + "$1,000 of expected deductions.",
    },
    {
      key: "additional_per_period", label: "Line 3 — Additional amount per pay",
      kind: "amount", decimals: 4, min: "0",
      help: "Added AFTER the rate is applied — it is a flat dollar amount, not a taxable "
        + "adjustment.",
    },
    {
      key: "exempt", label: "Exempt from Illinois withholding", kind: "flag",
      help: "Only valid where the employee is also exempt from federal withholding. Lines 1-3 are "
        + "left blank when this is claimed.",
    },
  ],
};

/** Illinois Form IL-W-5-NR — the non-residence certificate. */
const IL_W5NR: PayrollCertificate = {
  key: "us_il_ilw5nr",
  form: "IL-W-5-NR",
  label: "Employee's Statement of Nonresidence in Illinois",
  scope: { level: "region", region: "IL" },
  purpose: "non_residence",
  citation: "Illinois Form IL-W-5-NR (R-12/10); Publication 130 (R-02/26) p. 7",
  summary:
    "Claims exemption from Illinois withholding under a reciprocal agreement. Residence in Iowa, "
    + "Kentucky, Michigan or Wisconsin is NOT enough on its own: \"If your employee does not "
    + "complete this form, you must withhold Illinois Income Tax.\"",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state", label: "State of residence", kind: "choice",
      choices: [
        { value: "IA", label: "Iowa" },
        { value: "KY", label: "Kentucky" },
        { value: "MI", label: "Michigan" },
        { value: "WI", label: "Wisconsin" },
      ],
      required: true,
      help: "The reciprocal state the employee resides in. The employee must notify the employer "
        + "within ten days of moving.",
    },
    {
      key: "military_spouse", label: "Military spouse (MSRRA)", kind: "flag",
      help: "Claimed instead of a reciprocal state where the employee is in Illinois only because "
        + "their spouse is stationed here.",
    },
  ],
};

/** Pennsylvania Form REV-419 — the non-residence certificate. */
const PA_REV419: PayrollCertificate = {
  key: "us_pa_rev419",
  form: "REV-419",
  label: "Employee's Nonwithholding Application Certificate (Pennsylvania)",
  scope: { level: "region", region: "PA" },
  purpose: "non_residence",
  citation:
    "PA Form REV-419 (EX) 09-20; REV-415 Employer Withholding Information Guide p. 10; "
    + "PA PIT Guide (DSM-12, 12-2023) p. 3",
  summary:
    "The only certificate Pennsylvania takes from an employee. It switches withholding OFF for a "
    + "resident of a reciprocal state — it never adjusts an amount, because the rate is flat and "
    + "there is nothing to elect. Without it, the full 3.07% is withheld.",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state", label: "Reciprocal state of residence", kind: "choice",
      choices: [
        { value: "IN", label: "Indiana" },
        { value: "MD", label: "Maryland" },
        { value: "NJ", label: "New Jersey" },
        { value: "OH", label: "Ohio" },
        { value: "VA", label: "Virginia" },
        { value: "WV", label: "West Virginia" },
      ],
      help: "Box b. The employer must then withhold the employee's HOME state's tax instead — "
        + "reciprocity is conditional on that actually happening, not just on the form.",
    },
    {
      key: "tax_forgiveness", label: "Box a — Qualifies for Tax Forgiveness", kind: "flag",
      help: "A different claim from reciprocity: the employee expects a full refund of all PA tax "
        + "withheld. The employer must notify the Department if quarterly PA compensation exceeds "
        + "$1,625.",
    },
    {
      key: "military_spouse", label: "Box c — Military spouse (SCRA)", kind: "flag",
      help: "Legal resident of another state, not subject to PA withholding under the "
        + "Servicemembers Civil Relief Act.",
    },
  ],
};

/** Pennsylvania Form CLGS-32-6 — the Act 32 residency certification. */
const PA_CLGS32_6: PayrollCertificate = {
  key: "us_pa_clgs32_6",
  form: "CLGS-32-6",
  label: "Residency Certification Form (Local Earned Income Tax Withholding)",
  scope: { level: "region", region: "PA" },
  purpose: "withholding",
  citation: "PA DCED Form CLGS-32-6 (05/17); Act 32 of 2008",
  summary:
    "Identifies the employee's home and work political subdivisions by PSD code, so the Act 32 "
    + "higher-of comparison can be made. Required on hire and on any address change.",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_psd_code", label: "Resident PSD code", kind: "code",
      subRegion: { side: "residence" },
      help: "The six-digit political subdivision code for where the employee LIVES. The first two "
        + "digits are the tax collection district, the first four the school district. An "
        + "out-of-state residence is 880000, with a 0% resident rate.",
    },
    {
      key: "work_psd_code", label: "Work location PSD code", kind: "code",
      subRegion: { side: "work" },
      help: "The six-digit code for the address the employee reports to work at. Look both codes "
        + "up with DCED's address search — do not guess them from a municipality name.",
    },
  ],
};

/** New Jersey Form NJ-W4 (1-21). */
const NJ_W4: PayrollCertificate = {
  key: "us_nj_njw4",
  form: "NJ-W4",
  label: "Employee's Withholding Allowance Certificate (New Jersey)",
  scope: { level: "region", region: "NJ" },
  purpose: "withholding",
  citation: "NJ Form NJ-W4 (1-21); NJ-WT (September 2025) pp. 9–11 and 24",
  summary:
    "Sets New Jersey withholding. NJ-WT: \"Do not use the federal W-4 to calculate New Jersey "
    + "withholdings because employees cannot claim personal exemptions on the federal form.\"",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status", label: "Line 2 — Filing status", kind: "choice",
      choices: [
        { value: "single", label: "Single" },
        { value: "married_joint", label: "Married/Civil Union Couple Joint" },
        { value: "married_separate", label: "Married/Civil Union Partner Separate" },
        { value: "head_household", label: "Head of Household" },
        { value: "surviving_spouse", label: "Qualifying Widow(er)/Surviving Civil Union Partner" },
      ],
      default: "single", required: true,
      help: "Boxes 1 and 3 are withheld at Rate A; boxes 2, 4 and 5 at Rate B unless the employee "
        + "selects a rate on line 3.",
    },
    {
      key: "rate_table", label: "Line 3 — Rate table selected from the Wage Chart", kind: "choice",
      choices: [
        { value: "A", label: "Rate A" },
        { value: "B", label: "Rate B" },
        { value: "C", label: "Rate C" },
        { value: "D", label: "Rate D" },
        { value: "E", label: "Rate E" },
      ],
      help: "Only for a married/civil union couple filing jointly, head of household or surviving "
        + "partner whose household has more than one income: the Wage Chart on the NJ-W4 raises "
        + "the rate table so the combined income is not under-withheld. Blank means the filing "
        + "status decides.",
    },
    {
      key: "allowances", label: "Line 4 — Total withholding allowances", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Each one is worth $19.20 a week, $1,000 a year. NJ-WT states no rule for an employee "
        + "with no NJ-W4 on file at all, so the default here is zero — the answer that "
        + "over-withholds rather than under-withholds.",
    },
    {
      key: "additional_per_period", label: "Line 5 — Additional amount per pay",
      kind: "amount", decimals: 4, min: "0",
      help: "Deducted from each pay on top of the amount the rate table produces.",
    },
    {
      key: "exempt", label: "Line 6 — EXEMPT", kind: "flag",
      help: "Claimed where the employee expects wages plus taxable non-wage income of $10,000 or "
        + "less ($20,000 for a joint filer, head of household or surviving partner). Good for ONE "
        + "year: a new form is due each year.",
    },
  ],
};

/** New Jersey Form NJ-165 — the non-residence certificate. */
const NJ_165: PayrollCertificate = {
  key: "us_nj_nj165",
  form: "NJ-165",
  label: "Employee's Certificate of Nonresidence in New Jersey",
  scope: { level: "region", region: "NJ" },
  purpose: "non_residence",
  citation: "NJ Form NJ-165; NJ-WT (September 2025) p. 8",
  summary:
    "The Pennsylvania half of the PA/NJ reciprocal agreement. \"You are not required to withhold "
    + "on compensation paid to Pennsylvania residents working in New Jersey if they file an "
    + "Employee's Certificate of Nonresidence in New Jersey (Form NJ-165). … You must withhold "
    + "New Jersey tax if your employee does not complete the certificate.\"",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state", label: "State of residence", kind: "choice",
      choices: [{ value: "PA", label: "Pennsylvania" }],
      required: true,
      help: "Pennsylvania is the ONLY state New Jersey has a reciprocal agreement with. New York "
        + "is not one: a New York resident working in New Jersey is withheld New Jersey tax in "
        + "full.",
    },
    {
      key: "military_spouse", label: "Military spouse (MSRRA)", kind: "flag",
      help: "Filed with a copy of the spousal military identification card, instead of a "
        + "reciprocal-state claim, where the employee is in New Jersey only because their spouse "
        + "is stationed here.",
    },
  ],
};

/** Ohio Form IT 4 (Rev. 01/24) — one form, three jurisdictions and a waiver. */
const OH_IT4: PayrollCertificate = {
  key: "us_oh_it4",
  form: "IT 4",
  label: "Employee's Withholding Exemption Certificate (Ohio)",
  scope: { level: "region", region: "OH" },
  purpose: "withholding",
  citation: "Ohio Form IT 4 (Rev. 01/24); Ohio Employer Withholding Tables (2026)",
  summary:
    "Sets Ohio and school district withholding, and carries the reciprocity waiver. As of 7 "
    + "December 2020 it replaces the separate IT 4NR, IT 4 MIL and IT MIL SP.",
  storage: "certificate_rows",
  fields: [
    {
      key: "school_district", label: "School district of residence (number)", kind: "code",
      subRegion: { side: "residence" },
      help: "The FOUR-DIGIT district number from The Finder at tax.ohio.gov — the employee's "
        + "district of RESIDENCE, not of work. A district that levies no income tax still has a "
        + "number; only 214 of them tax.",
    },
    {
      key: "line1_self", label: "Line 1 — Self", kind: "count", min: "0", max: "1", default: "0",
      help: "\"Enter 0 if you are a dependent on another individual's Ohio return; otherwise "
        + "enter 1.\"",
    },
    {
      key: "line2_spouse", label: "Line 2 — Spouse", kind: "count", min: "0", max: "1",
      default: "0",
      help: "\"Enter 0 if single or if your spouse files a separate Ohio return; otherwise "
        + "enter 1.\"",
    },
    {
      key: "line3_dependents", label: "Line 3 — Dependents", kind: "count",
      min: "0", max: "99", default: "0",
      help: "The number of dependents claimed. Ohio grants no additional exemption for age or "
        + "blindness on the IT 4 — those are credits on the annual return.",
    },
    {
      key: "total_exemptions", label: "Line 4 — Total withholding exemptions", kind: "count",
      min: "0", max: "99", default: "0",
      help: "The sum of lines 1, 2 and 3. Worth $650 a year each, deducted from annualized wages "
        + "before the rate is applied. With no IT 4 on file the total is zero.",
    },
    {
      key: "additional_per_period", label: "Line 5 — Additional Ohio withholding per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "In whole dollars on the form. Added after the tables, not taxed by them.",
    },
    {
      key: "reciprocity_state", label: "Section III — Full-year resident of a reciprocal state",
      kind: "choice",
      choices: [
        { value: "IN", label: "Indiana" },
        { value: "KY", label: "Kentucky" },
        { value: "MI", label: "Michigan" },
        { value: "PA", label: "Pennsylvania" },
        { value: "WV", label: "West Virginia" },
      ],
      help: "\"I am not subject to Ohio or school district income tax withholding because I am a "
        + "full-year resident of Indiana, Kentucky, Michigan, Pennsylvania, or West Virginia.\" "
        + "It waives the STATE and SCHOOL DISTRICT tax and says nothing about municipal income "
        + "tax — a Kentucky resident working in an Ohio city still pays the city.",
    },
    {
      key: "military_waiver", label: "Section III — Military or military spouse waiver",
      kind: "flag",
      help: "A resident servicemember stationed outside Ohio, a nonresident servicemember "
        + "stationed in Ohio, or a nonresident civilian spouse present solely on those orders.",
    },
  ],
};

/**
 * The Ohio municipal work location — the employer's own record, not a form.
 *
 * R.C. 718.03 obliges an employer to withhold the municipal income tax of the
 * municipality the work is PERFORMED IN, and Ohio prints no employee
 * certificate that asks which one it is: the IT 4 collects the school district
 * of residence and nothing municipal. So the fact lives with the employer, who
 * knows the work address, and it is declared here for the same reason
 * `us_mi_nonresidency` is — the resolution's question is "which municipality is
 * this employee in?", the state's answer is "a record you keep", and declaring
 * it keeps the answer per employee instead of assumed.
 *
 * WORK ONLY. Withholding for the employee's RESIDENCE municipality is Ohio's
 * "courtesy withholding": permitted, commonly agreed to, and not required —
 * R.C. 718.03(A)(2) makes it an election the employer makes, not a fact about
 * the employee. It is not declared here because entering it would make it
 * mandatory, and the relief between the two municipalities is a residence
 * CREDIT claimed on the municipal return rather than a withholding offset.
 */
const OH_MUNICIPAL_RECORD: PayrollCertificate = {
  key: "us_oh_municipal_record",
  form: "(employer-determined)",
  label: "Ohio municipality of employment",
  scope: { level: "region", region: "OH" },
  purpose: "withholding",
  citation: "Ohio Rev. Code 718.03 and 718.011; Ohio Department of Taxation, The Finder",
  summary:
    "The municipality the employee's work is performed in, which the employer determines from the "
    + "work address. Ohio publishes no employee form for it and several hundred municipalities "
    + "levy, so the code is the pack's own convention: the municipality's name in capitals.",
  storage: "certificate_rows",
  fields: [
    {
      key: "work_municipality", label: "Municipality the work is performed in", kind: "code",
      subRegion: { side: "work" },
      help: "The municipality's name in CAPITALS, underscores for spaces (COLUMBUS, UPPER_ARLINGTON) "
        + "— look the work address up in The Finder at tax.ohio.gov. Leave it blank if the work "
        + "address is in no taxing municipality. Its RATE is entered separately against the "
        + "jurisdiction, because Ohio publishes no municipal rate table a payroll release could "
        + "carry: a municipality with no rate on file refuses the run rather than withholding zero.",
    },
  ],
};

/** Michigan Form MI-W4 (Rev. 12-20). */
const MI_W4: PayrollCertificate = {
  key: "us_mi_miw4",
  form: "MI-W4",
  label: "Employee's Michigan Withholding Exemption Certificate",
  scope: { level: "region", region: "MI" },
  purpose: "withholding",
  citation: "Michigan Form MI-W4 (Rev. 12-20); Form 446 (Rev. 02-26) p. 4",
  summary:
    "Every Michigan employer must obtain one. \"The federal W-4 cannot be used in place of the "
    + "MI-W4.\" Any writing on the certificate other than the entries required makes it invalid.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exemptions", label: "Line 6 — Personal and dependency exemptions", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Worth $5,900 a year each in 2026. \"If you fail or refuse to file the form, your "
        + "employer must withhold Michigan income tax from your wages without allowance for any "
        + "exemptions\" — which is why the default is zero.",
    },
    {
      key: "additional_per_period", label: "Line 7 — Additional amount per pay",
      kind: "amount", decimals: 4, min: "0",
      help: "Only if the employer agrees. A flat amount, added after the rate.",
    },
    {
      key: "exempt", label: "Line 8 — Claiming exemption from withholding", kind: "flag",
      help: "Line 8a (no Michigan liability expected), 8b (wages exempt — including residence in "
        + "a reciprocal state or a tribal agreement area) or 8c (domicile in a Renaissance Zone). "
        + "An employer must send Treasury any MI-W4 claiming exemption or ten or more exemptions.",
    },
  ],
};

/**
 * Michigan's nonresidency statement — the certificate the state does NOT
 * publish.
 *
 * Form 446 (Rev. 02-26): "Treasury does not furnish nonresidency certificates.
 * The employer may develop a form or obtain a letter from the employee. The
 * form or letter should contain the employee's name, legal address, Social
 * Security number, and a statement signed and dated by the employee confirming
 * their legal address. The employer keeps the form as its authority not to
 * withhold Michigan income tax."
 *
 * It is declared here anyway, and that is the point. The reciprocity resolver's
 * question is "is the authority on file?", and Michigan's answer is a document
 * with no form number. Declaring it keeps the answer recorded per employee
 * instead of assumed, and keeps the agreement from applying to somebody who
 * merely lives in Ohio and never told their employer in writing.
 */
const MI_NONRESIDENCY: PayrollCertificate = {
  key: "us_mi_nonresidency",
  form: "(employer-developed)",
  label: "Statement of Nonresidence in Michigan (employer's own form or a letter)",
  scope: { level: "region", region: "MI" },
  purpose: "non_residence",
  citation: "Michigan Form 446 (Rev. 02-26) p. 4, \"Certificate of Nonresidency\"",
  summary:
    "Michigan publishes no nonresidency certificate. The employer develops a form or takes a "
    + "signed letter and keeps it as its authority not to withhold Michigan tax from a resident "
    + "of a reciprocal state.",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state", label: "State of legal residence", kind: "choice",
      choices: [
        { value: "IL", label: "Illinois" },
        { value: "IN", label: "Indiana" },
        { value: "KY", label: "Kentucky" },
        { value: "MN", label: "Minnesota" },
        { value: "OH", label: "Ohio" },
        { value: "WI", label: "Wisconsin" },
      ],
      required: true,
      help: "Michigan has reciprocal agreements with exactly these six states. Their employers "
        + "likewise do not withhold their own tax from Michigan residents, though they may "
        + "register with Treasury to withhold Michigan's voluntarily.",
    },
    {
      key: "signed_on", label: "Date the employee signed the statement", kind: "code",
      help: "The statement must be signed and dated by the employee. Keep it — it is the "
        + "employer's only authority for not withholding.",
    },
  ],
};

/** Detroit Form 5527 — kept by the employer, never filed. */
const MI_5527: PayrollCertificate = {
  key: "us_mi_5527",
  form: "5527",
  label: "City of Detroit Withholding Exemption Certificate",
  scope: { level: "sub_region", region: "MI", subRegion: "DETROIT" },
  purpose: "withholding",
  citation: "Michigan Department of Treasury Form 5469 (Rev. 05-25), 2026 City of Detroit Income "
    + "Tax Withholding Guide",
  summary:
    "Sets the exemption count and the share of work performed in Detroit. \"Do not mail Form 5527 "
    + "to the city or the Michigan Department of Treasury; these are for the employer's use and "
    + "must be retained in the employer's files.\"",
  storage: "certificate_rows",
  fields: [
    {
      key: "exemptions", label: "Number of exemptions", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Worth $600 a year each — $11.54 a week. Detroit allows additional exemptions where "
        + "the employee or spouse is 65 or over, or blind, which the federal rules do not.",
    },
    {
      key: "detroit_work_percent", label: "Percentage of work performed in Detroit",
      kind: "choice",
      choices: [
        { value: "0_25", label: "0%–25%" },
        { value: "26_50", label: "26%–50%" },
        { value: "51_75", label: "51%–75%" },
        { value: "76_80", label: "76%–80%" },
        { value: "81_100", label: "81%–100%" },
      ],
      help: "A NONRESIDENT is withheld on that share of gross pay: at 60%, $200 of pay is $120 of "
        + "Detroit wages. A resident is withheld on all of it, wherever the work is done.",
    },
  ],
};

/** Massachusetts Form M-4. */
const MA_M4: PayrollCertificate = {
  key: "us_ma_m4",
  form: "M-4",
  label: "Massachusetts Employee's Withholding Exemption Certificate",
  scope: { level: "region", region: "MA" },
  purpose: "withholding",
  citation: "Massachusetts Form M-4; Circular M (Rev. 12/25) p. 12",
  summary:
    "\"If you do not file a certificate, your employer must withhold on the basis of no "
    + "exemptions.\" A claimed spouse counts as FOUR exemptions, not one.",
  storage: "certificate_rows",
  fields: [
    {
      key: "total_exemptions", label: "Line 4 — Total withholding exemptions", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Lines 1 to 3 added: self (1, or 2 if 65 or over), spouse (4, or 5 if the spouse is "
        + "65 or over) and dependents. \"Entering 4 makes a withholding system adjustment for the "
        + "$4,400 exemption for a spouse\" — it is a scale, not a headcount.",
    },
    {
      key: "additional_per_period", label: "Line 5 — Additional withholding per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Under agreement with the employer.",
    },
    {
      key: "head_of_household", label: "Box A — Will file as head of household", kind: "flag",
      help: "Subtracts a fixed amount from the computed TAX — $2.31 a week, $120 a year — not "
        + "from the wages.",
    },
    {
      key: "blind", label: "Box B — Employee is blind", kind: "flag",
      help: "Subtracts $2.12 a week, $110 a year, from the computed tax.",
    },
    {
      key: "spouse_blind", label: "Box C — Spouse is blind and not subject to withholding",
      kind: "flag",
      help: "A second blindness adjustment, on the same terms as the employee's.",
    },
    {
      key: "student_exempt", label: "Box D — Full-time student under $8,000", kind: "flag",
      help: "A full-time student in seasonal, part-time or temporary work whose annual income "
        + "will not exceed $8,000. Circular M is explicit: \"Employer: Do not withhold if D is "
        + "filled in.\"",
    },
  ],
};

/** Georgia Form G-4 (Rev. 08/15/24). */
const GA_G4: PayrollCertificate = {
  key: "us_ga_g4",
  form: "G-4",
  label: "State of Georgia Employee's Withholding Allowance Certificate",
  scope: { level: "region", region: "GA" },
  purpose: "withholding",
  citation:
    "Georgia Form G-4 (Rev. 08/15/24); Employer's Withholding Tax Guide 2026 (revised June 2026)",
  summary:
    "Georgia claims no personal allowance for the employee or spouse — the standard deduction "
    + "does that work, and the letter on line 7 chooses which one. \"Failure to submit a properly "
    + "completed Form G-4 results in the employer withholding as though the employee is single "
    + "with zero allowances.\"",
  storage: "certificate_rows",
  fields: [
    {
      key: "marital_status", label: "Line 3 / Line 7 — Marital status letter", kind: "choice",
      choices: [
        { value: "A", label: "A — Single" },
        {
          value: "B", label: "B — Married filing separate, or married filing joint both working",
          help: "Takes the MARRIED FILING SEPARATE standard deduction, which is the single "
            + "figure: a two-earner couple would otherwise be given the joint deduction twice.",
        },
        { value: "C", label: "C — Married filing joint, one spouse working" },
        { value: "D", label: "D — Head of household" },
      ],
      default: "A", required: true,
      help: "The letter the employer uses to pick the standard-deduction column in the "
        + "Employer's Tax Guide.",
    },
    {
      key: "dependent_allowances", label: "Line 4 — Dependent allowances", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Worth $5,000 a year each from 11 May 2026 (HB 463), $4,000 before it.",
    },
    {
      key: "adjustment_allowances", label: "Line 5 — Georgia adjustments allowances", kind: "count",
      min: "0", max: "99", default: "0",
      help: "From the G-4's own worksheet, one per $4,000 of itemized deductions and Georgia "
        + "adjustments above the standard deduction. Line 7 totals lines 4 and 5, and the "
        + "employer uses the total.",
    },
    {
      key: "additional_per_period", label: "Line 6 — Additional withholding",
      kind: "amount", decimals: 4, min: "0",
      help: "Per pay period, authorised by the employee's signature on the form.",
    },
    {
      key: "exempt", label: "Line 8 — Exempt from Georgia withholding", kind: "flag",
      help: "No Georgia liability last year and none expected this year (8a), or the "
        + "Servicemembers Civil Relief Act (8b). An employer must mail Georgia any G-4 claiming "
        + "exempt or more than 14 allowances.",
    },
  ],
};

/** North Carolina Form NC-4 (Web 11-24). */
const NC_NC4: PayrollCertificate = {
  key: "us_nc_nc4",
  form: "NC-4",
  label: "North Carolina Employee's Withholding Allowance Certificate",
  scope: { level: "region", region: "NC" },
  purpose: "withholding",
  citation: "NC Form NC-4 (Web 11-24); NC-30 (2026) sections 13 and 27",
  summary:
    "\"If you do not submit Form NC-4 to your employer, your employer must withhold as if your "
    + "filing status is 'Single' with no allowances.\" Form NC-4 EZ and Form NC-4 NRA are the "
    + "same certificate for simpler cases and for nonresident aliens.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status", label: "Filing status", kind: "choice",
      choices: [
        { value: "single_or_separate", label: "Single or Married Filing Separately" },
        { value: "head_household", label: "Head of Household" },
        { value: "joint_or_surviving", label: "Married Filing Jointly or Surviving Spouse" },
      ],
      default: "single_or_separate", required: true,
      help: "NC-30 prints only TWO schedules — \"Single Person, Married Person, or Surviving "
        + "Spouse\" and \"Head of Household\" — so every status except head of household uses "
        + "the same table.",
    },
    {
      key: "allowances", label: "Line 1 — Total withholding allowances", kind: "count",
      min: "0", max: "99", default: "0",
      help: "From line 17 of the NC-4 Allowance Worksheet. Worth $2,500 a year each. An employer "
        + "must send the Department any NC-4 claiming more than 10.",
    },
    {
      key: "additional_per_period", label: "Line 2 — Additional amount per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "In whole dollars on the form.",
    },
    {
      key: "exempt", label: "NC-4 EZ line 3 or 4 — Exempt", kind: "flag",
      help: "No North Carolina liability last year and none expected this year, or the "
        + "Servicemembers Civil Relief Act military-spouse exemption. A new NC-4 EZ is due each "
        + "year: \"On February 16, begin withholding for each employee who previously claimed "
        + "exemption but has not given you a new Form NC-4 EZ.\"",
    },
  ],
};

const US_CERTIFICATES: PayrollPackCertificates = {
  country: "US",
  certificates: [
    W4, CA_DE4, NY_IT2104, NY_IT2104_1, IL_W4, IL_W5NR, PA_REV419, PA_CLGS32_6,
    NJ_W4, NJ_165, OH_IT4, OH_MUNICIPAL_RECORD, MI_W4, MI_NONRESIDENCY, MI_5527,
    MA_M4, GA_G4, NC_NC4,
  ],
};

// ===========================================================================
// Withholding jurisdictions
// ===========================================================================

const CA_REGION: PayrollRegionWithholding = {
  region: "CA",
  label: "California PIT",
  implemented: true,
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by the research pass: whether California requires an
  // employer to withhold from a California resident's wages earned in another
  // state. Declared `unknown` rather than guessed, so a Californian working out
  // of state is refused by name instead of silently under- or over-withheld.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ca_de4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation: "California EDD, California Withholding Schedules for 2026, Method B; DE 44 Rev. 52",
};

const NY_REGION: PayrollRegionWithholding = {
  region: "NY",
  label: "New York State income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // NYS-50 (12/23) part P: "In addition to withholding New York State tax, you
  // may also be required to withhold income tax from wages paid to a New York
  // State resident according to the laws of other states... To avoid double
  // withholding, the amount of New York State income tax that would otherwise
  // be required to be withheld ... should be REDUCED by the amount of income
  // tax required to be withheld according to the laws of other states."
  residentWithholding: "required_net_of_credit",
  // Not implemented: computing the offset needs the other state's withholding
  // as an input and a rule for which of the two is authoritative when they
  // disagree. Declared, refused, not approximated.
  residentWithholdingImplemented: false,
  certificateKey: "us_ny_it2104",
  subRegions: [
    {
      code: "NYC",
      label: "New York City resident income tax",
      kind: "city",
      // RESIDENTS ONLY. "Nonresidents of New York City are not liable for New
      // York City personal income tax." And the converse: a city resident owes
      // it on wages earned anywhere, "even though the services may have been
      // performed outside New York City".
      reaches: ["resident"],
      rateSource: { kind: "pack" },
      certificateKey: "us_ny_it2104",
      citation: "NYS-50-T-NYC (1/26), Method II; Publication NYS-50 (12/23) part G",
      implemented: true,
    },
    {
      code: "YONKERS",
      label: "Yonkers income tax",
      kind: "city",
      // TWO different taxes on two populations: a resident surcharge of 16.75%
      // of the New York State tax, and a nonresident earnings tax of 0.50% of
      // Yonkers-source gross wages.
      reaches: ["resident", "nonresident"],
      rateSource: { kind: "pack" },
      certificateKey: "us_ny_it2104",
      citation: "NYS-50-T-Y (1/26); Publication NYS-50 (12/23) part H",
      implemented: true,
    },
  ],
  // A New York City resident who works in Yonkers owes the city's resident tax
  // AND the Yonkers nonresident earnings tax; neither offsets the other.
  subRegionConflictRule: "both",
  citation: "NYS-50-T-NYS (1/26); Publication NYS-50 (12/23)",
};

const PA_REGION: PayrollRegionWithholding = {
  region: "PA",
  label: "Pennsylvania personal income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // PA PIT Guide p. 5 / REV-415 p. 9: a Pennsylvania resident working partly
  // outside Pennsylvania allocates by working days, and where the other state
  // has NO income tax the employer withholds PA tax on the entire compensation.
  // So Pennsylvania does require resident withholding on out-of-state wages.
  residentWithholding: "required",
  // The working-day allocation needs a day count this engine is not given.
  residentWithholdingImplemented: false,
  // Pennsylvania publishes no withholding allowance certificate at all.
  certificateKey: undefined,
  subRegions: [
    {
      code: "PHILADELPHIA",
      label: "Philadelphia wage tax",
      kind: "city",
      reaches: ["resident", "nonresident"],
      rateSource: { kind: "pack" },
      // Outside Act 32 (levied under the Sterling Act), so it does NOT enter
      // the higher-of comparison: "Act 32 does not apply. Employers are
      // required to withhold the Philadelphia resident rate for employees who
      // live in Philadelphia, but work outside of Philadelphia."
      settlesIndependently: true,
      citation: "City of Philadelphia Wage Tax (Sterling Act); DCED Local Withholding Tax FAQs",
      implemented: true,
    },
  ],
  openSubRegions: {
    kind: "Act 32 taxing jurisdiction",
    label: "PA local earned income tax (PSD {code})",
    // Six-digit PSD code: first two digits the tax collection district, first
    // four the school district, all six the political subdivision.
    codePattern: "^\\d{6}$",
    reaches: ["resident", "nonresident"],
    rateSource: { kind: "tenant", rateKey: "us_pa_local_eit" },
    certificateKey: "us_pa_clgs32_6",
    citation: "Act 32 of 2008; PA DCED Local Withholding Tax FAQs and PSD register",
    implemented: true,
  },
  // "The applicable EIT rate owed and to be withheld is always the higher of
  // the two rates" — total resident rate vs work-location nonresident rate.
  subRegionConflictRule: "higher_rate",
  citation: "PA REV-415, REV-580 and the PA PIT Guide; Act 32 of 2008",
};

const IL_REGION: PayrollRegionWithholding = {
  region: "IL",
  label: "Illinois income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // NOT ESTABLISHED: Publication 130 states Illinois's claim over compensation
  // "paid in Illinois", and does not state a rule for an Illinois resident's
  // wages paid in another state. Declared unknown rather than assumed.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_il_ilw4",
  subRegions: [],
  // Illinois Constitution art. VII §6(e): a home rule unit may impose taxes on
  // income or earnings only where the General Assembly provides by law, and no
  // employer-withheld local income tax appears in any IDOR publication. There
  // is nothing below the state to settle.
  subRegionConflictRule: "both",
  citation: "Booklet IL-700-T (R-12/25); Publication 130 (R-02/26)",
};

const NJ_REGION: PayrollRegionWithholding = {
  region: "NJ",
  label: "New Jersey gross income tax",
  implemented: true,
  // NJ-WT p. 8: "You must withhold New Jersey tax from compensation paid to
  // nonresident employees working in New Jersey."
  taxesNonresidentWages: true,
  // NJ-WT p. 8, and this is the rule the whole NJ/NY case turns on: a resident
  // needs no New Jersey withholding only if they are "employed totally outside
  // New Jersey", "subject to the withholding tax of that state", AND "the
  // withholdings required by that state equal or exceed the withholdings
  // required for New Jersey". Otherwise "you must withhold New Jersey taxes IN
  // ADDITION TO the other state to offset the employee's resident income tax
  // liability."
  residentWithholding: "required_net_of_credit",
  // Not implemented, for the same reason New York's is not: the offset needs
  // the other state's withholding as an input and a rule for the part-time
  // case. Declared and refused, never approximated — a New Jersey resident
  // working in New York is the single most common cross-border employee in the
  // country and silently withholding New York only under-withholds them.
  residentWithholdingImplemented: false,
  certificateKey: "us_nj_njw4",
  // New Jersey has NO local wage tax an employer withholds. Newark and Jersey
  // City levy payroll taxes, and both are levied ON THE EMPLOYER as a
  // percentage of payroll — not withheld from the employee and not an income
  // tax — so they are not sub-region levies in this model at all.
  subRegions: [],
  subRegionConflictRule: "both",
  citation: "NJ-WT, New Jersey Income Tax Withholding Instructions (September 2025)",
};

/**
 * Ohio: the state, 214 school districts, and several hundred municipalities.
 *
 * The school districts are DERIVED from the transcribed rate table in
 * `states/oh.ts` rather than listed again here. Two lists of the same 214
 * jurisdictions would disagree the first time one was updated, and the one that
 * matters — the one with the rates — is the one the engine reads.
 */
const OH_SCHOOL_DISTRICT_LEVIES = OH_SCHOOL_DISTRICTS_2026.map((district) => ({
  code: district.code,
  label: `${district.name} school district income tax (${district.printedPercent}%)`,
  kind: "school district",
  // RESIDENCE ONLY. "School district taxes are based on the employee's
  // residence, not work location." A commuter into a taxing district owes it
  // nothing; a resident owes it on wages earned anywhere.
  reaches: ["resident"] as const,
  rateSource: { kind: "pack" } as const,
  certificateKey: "us_oh_it4",
  citation:
    "Ohio Rev. Code 5748.01; Ohio Department of Taxation, School Districts With an Income Tax as "
    + `of January 2026 (December 30, 2025) — ${district.base === "earned_income"
      ? "earned income only base"
      : "traditional base"}`,
  implemented: true,
}));

/**
 * The Ohio municipalities named individually.
 *
 * Naming them buys a label an operator recognises and an assertion that they
 * exist; it does NOT buy a rate, because no state publication carries one (see
 * `states/local-rates.ts`). Everything else municipal is admitted by the open
 * registry below on the same terms.
 */
const OH_NAMED_MUNICIPALITIES = [
  "AKRON", "CANTON", "CINCINNATI", "CLEVELAND", "COLUMBUS", "DAYTON", "HAMILTON",
  "LORAIN", "PARMA", "SPRINGFIELD", "TOLEDO", "YOUNGSTOWN",
].map((code) => ({
  code,
  label: `${code.charAt(0)}${code.slice(1).toLowerCase()} municipal income tax`,
  kind: "municipality",
  // Ohio municipalities tax wages earned in the municipality by anyone, and
  // their own residents' wages earned anywhere. One rate reaches both; what
  // differs is the residence credit, which is claimed on the municipal return.
  reaches: ["resident", "nonresident"] as const,
  rateSource: { kind: "tenant", rateKey: "us_oh_municipal" } as const,
  citation: "Ohio Rev. Code Chapter 718; the municipality's own income tax ordinance",
  implemented: true,
}));

const OH_REGION: PayrollRegionWithholding = {
  region: "OH",
  label: "Ohio income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by this research pass: whether Ohio requires an employer to
  // withhold from an Ohio RESIDENT's wages earned in a state Ohio has no
  // agreement with. The Department's employer guidance states the obligation
  // for employers "maintaining an office or transacting business in Ohio"
  // without addressing work performed elsewhere. Declared unknown rather than
  // guessed, so the resolver refuses that employee by name.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_oh_it4",
  subRegions: [...OH_SCHOOL_DISTRICT_LEVIES, ...OH_NAMED_MUNICIPALITIES],
  openSubRegions: {
    kind: "municipality",
    label: "Ohio municipal income tax ({code})",
    // The pack's own convention, because Ohio has no universal municipal code:
    // the municipality's name in capitals, underscores for spaces.
    codePattern: "^[A-Z][A-Z0-9_.'-]{1,40}$",
    reaches: ["resident", "nonresident"],
    rateSource: { kind: "tenant", rateKey: "us_oh_municipal" },
    citation: "Ohio Rev. Code Chapter 718; the municipality's own income tax ordinance",
    implemented: true,
  },
  // A school district tax and a municipal tax are different taxes levied by
  // different authorities on the same employee, and a work municipality and a
  // residence municipality both have a claim: all of them are withheld. What
  // Ohio does NOT do is settle them against each other — the relief between a
  // residence municipality and a work municipality is a CREDIT on the municipal
  // return, not a withholding offset.
  subRegionConflictRule: "both",
  citation:
    "Ohio Employer Withholding Tables and Optional Computer Formula, effective October 1, 2025 "
    + "and August 1, 2026; Ohio Rev. Code Chapters 5747, 5748 and 718",
};

/**
 * Michigan's twenty-four cities, from the closed statutory list.
 *
 * Detroit's rates are published by the Department of Treasury and are pack
 * constants; the rest are the city's own and are employer-entered. The
 * distinction is visible right here, in `rateSource`, rather than buried in an
 * engine.
 */
const MI_CITY_LEVIES = MI_TAXING_CITIES.map((code) => ({
  code,
  label: code === "DETROIT"
    ? "City of Detroit income tax"
    : `${code.split("_").map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(" ")} `
      + "city income tax",
  kind: "city",
  // Residents on all their compensation, nonresidents on the part earned in the
  // city. Two different rates, the nonresident one at half the resident one.
  reaches: ["resident", "nonresident"] as const,
  rateSource: code === "DETROIT"
    ? { kind: "pack" } as const
    : { kind: "tenant", rateKey: "us_mi_city" } as const,
  ...(code === "DETROIT" ? { certificateKey: "us_mi_5527" } : {}),
  citation: code === "DETROIT"
    ? "Michigan Department of Treasury Form 5469 (Rev. 05-25), 2026 City of Detroit Income Tax "
      + "Withholding Guide"
    : "Michigan City Income Tax Act, MCL 141.501 et seq.; the city's own income tax ordinance",
  implemented: true,
}));

const MI_REGION: PayrollRegionWithholding = {
  region: "MI",
  label: "Michigan income tax",
  implemented: true,
  // Form 446 p. 1: "Employers located outside Michigan that have employees who
  // work in Michigan must register and withhold Michigan income tax from all
  // employees working in Michigan."
  taxesNonresidentWages: true,
  // Form 446 p. 1: "Employers located in Michigan assigning a Michigan resident
  // employee to work TEMPORARILY in another state must withhold Michigan income
  // tax from compensation paid to the employee for work done in another state."
  residentWithholding: "required",
  // Not implemented, and the reason is the word "temporarily": the guide states
  // the rule for a temporary assignment and this engine is not told whether an
  // assignment is temporary. Withholding Michigan on top of the work state
  // would double-withhold a permanently out-of-state employee; not withholding
  // it would under-withhold a temporarily assigned one. The resolver refuses
  // and names the employee rather than picking.
  residentWithholdingImplemented: false,
  certificateKey: "us_mi_miw4",
  subRegions: MI_CITY_LEVIES,
  // No open registry: the Michigan City Income Tax Act admits these
  // twenty-four and no others, so a code that is not one of them is not a
  // Michigan taxing city and saying so is a better answer than admitting it.
  //
  // The conflict rule is Michigan's own count — Form 5469: "the employer must
  // withhold separately for BOTH the City of Detroit and the other city" — but
  // NOT the whole of Michigan's rule. The residence city's rate is REDUCED by
  // the work city's nonresident rate, which `both` cannot express and
  // `miResidentCityRate` applies instead. See states/mi.ts.
  subRegionConflictRule: "both",
  citation:
    "Michigan Form 446 (Rev. 02-26), 2026 Michigan Income Tax Withholding Guide; Michigan City "
    + "Income Tax Act, MCL 141.501 et seq.",
};

const MA_REGION: PayrollRegionWithholding = {
  region: "MA",
  label: "Massachusetts income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // NOT ESTABLISHED: Circular M is a table of rates and methods and states no
  // rule for a Massachusetts resident's wages earned in another state.
  // Declared unknown rather than assumed.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ma_m4",
  // Massachusetts has no local income taxes of any kind.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Massachusetts Circular M: Income Tax Withholding Tables at 5.0%, effective January 1, 2026 "
    + "(Rev. 12/25)",
};

const GA_REGION: PayrollRegionWithholding = {
  region: "GA",
  label: "Georgia income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by this pass: the Employer's Withholding Tax Guide states
  // no rule for a Georgia resident's wages earned in another state.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ga_g4",
  // Georgia permits no local income tax on wages.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Georgia Employer's Withholding Tax Guide 2026 (revised June 2026); House Bill 463",
};

const NC_REGION: PayrollRegionWithholding = {
  region: "NC",
  label: "North Carolina income tax",
  implemented: true,
  // NC-30 § 5(b): "A nonresident employee is subject to North Carolina
  // withholding on any part of their wages paid for performing services in this
  // State."
  taxesNonresidentWages: true,
  // NC-30 § 5(a): "An employee who is a resident of this State is subject to
  // North Carolina withholding on ALL of their wages, whether the employee
  // works within or outside the State; EXCEPT that … North Carolina withholding
  // is not required from wages paid to a resident for services performed in
  // another state if that state requires the employer to withhold."
  //
  // That exception is a full WAIVER conditioned on the other state's rule, not
  // a credit and not an unconditional requirement, and this declaration has no
  // value that says so — see the note in the handoff. `required` is the base
  // rule and the one that errs toward refusing rather than under-withholding.
  residentWithholding: "required",
  residentWithholdingImplemented: false,
  certificateKey: "us_nc_nc4",
  // North Carolina has no local income taxes.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "NC-30, 2026 Income Tax Withholding Tables and Instructions for Employers, sections 5 and 27",
};

const IMPLEMENTED: Readonly<Record<string, PayrollRegionWithholding>> = {
  CA: CA_REGION, NY: NY_REGION, PA: PA_REGION, IL: IL_REGION,
  NJ: NJ_REGION, OH: OH_REGION, MI: MI_REGION, MA: MA_REGION, GA: GA_REGION, NC: NC_REGION,
};

/**
 * Every US region, in `US_STATES` order.
 *
 * Three populations, and the difference between them is the whole point:
 *   - a state with an engine (four of them);
 *   - a state that levies NO wage income tax, which is not a gap — there is
 *     genuinely nothing to withhold, so it is `implemented` with
 *     `residentWithholding: "none"`;
 *   - a state that levies one and has not been transcribed, which is declared
 *     with `implemented: false` and a reason naming its publication. Declared,
 *     not omitted: an omitted state produces "unknown region", which reads like
 *     a data-entry error, where a declared one produces "Massachusetts income
 *     tax withholding is not implemented — transcribe Circular M".
 */
function everyUsRegion(): PayrollRegionWithholding[] {
  const implemented = new Set(implementedUsStates());
  return US_STATES.map((state): PayrollRegionWithholding => {
    const known = IMPLEMENTED[state];
    if (known) return known;
    if (NO_WITHHOLDING_STATES.has(state)) {
      return {
        region: state,
        label: `${state} (no wage income tax)`,
        implemented: true,
        taxesNonresidentWages: false,
        residentWithholding: "none",
        residentWithholdingImplemented: true,
        subRegions: [],
        subRegionConflictRule: "both",
        citation: "The state levies no personal income tax on wages",
      };
    }
    if (implemented.has(state)) {
      throw new Error(
        `${state} has a withholding engine but no jurisdiction declaration in `
        + "engine/src/payroll/us/jurisdictions.ts",
      );
    }
    const publication = usStatePublication(state);
    return {
      region: state,
      label: `${state} income tax`,
      implemented: false,
      unimplementedReason:
        `${state} levies a wage income tax and the US pack has not transcribed its tables. `
        + (publication ? `They are published in ${publication}. ` : "")
        + `Add engine/src/payroll/us/states/${state.toLowerCase()}.ts and register it.`,
      taxesNonresidentWages: true,
      residentWithholding: "unknown",
      residentWithholdingImplemented: false,
      subRegions: [],
      subRegionConflictRule: "both",
      citation: publication ?? `${state} withholding statute`,
    };
  });
}

const US_WITHHOLDING: PayrollPackWithholding = {
  country: "US",
  regions: everyUsRegion(),
};

// ===========================================================================
// Reciprocity
// ===========================================================================

/**
 * Interstate reciprocal agreements.
 *
 * DIRECTIONAL rows: each names the region the work is performed in and the
 * region the employee resides in, because the certificate differs by direction.
 * Only the directions this pack can act on are declared — an agreement is only
 * useful to a payroll engine when the WORK region is one it withholds for.
 *
 * NEW YORK HAS NONE, and its absence here is the assertion. Publication NYS-50,
 * the withholding-requirements page and the nonresident FAQs contain no
 * reciprocal provision, IT-2104.1 allocates by percentage of services rather
 * than by home state, and New York's only relief mechanism runs the other way
 * (a NY RESIDENT's withholding is reduced by another state's — nonresidents get
 * nothing). A New Jersey resident working in New York is withheld New York tax
 * in full, which is exactly what the canonical case is supposed to demonstrate.
 */
const US_RECIPROCITY: PayrollPackReciprocity = {
  country: "US",
  crossCountryNote:
    "Canada/US treaty relief is not modelled: an employee runs on exactly one country pack, so a "
    + "cross-border agreement has no pair of regions to relate.",
  agreements: [
    // --- Pennsylvania: six states, all on Form REV-419 -------------------
    ...(["IN", "MD", "NJ", "OH", "VA", "WV"] as const).map((residence) => ({
      workRegion: "PA",
      residenceRegion: residence,
      taxedBy: "residence" as const,
      certificateKey: "us_pa_rev419",
      // "no withholding of Pennsylvania personal income tax is required
      // PROVIDED an Employee's Nonwithholding Application Certificate
      // (REV-419) is filed by the nonresident employee with the Pennsylvania
      // employer." Without it, the full 3.07% is withheld and the employee
      // files a PA return for the refund.
      withoutCertificate: "work_region" as const,
      // NJ-WT (September 2025): "The reciprocal agreement does not excuse a
      // Pennsylvania employer from withholding LOCAL wage taxes imposed by
      // cities, towns, or other localities in Pennsylvania."
      relievesSubRegionLevies: false,
      citation:
        "PA PIT Guide (DSM-12, 12-2023) p. 3; REV-415 p. 10; Form REV-419 (EX) 09-20"
        + (residence === "NJ"
          ? "; NJ-WT (September 2025) p. 8 and nj.gov PA/NJ Reciprocal Income Tax Agreement"
          : ""),
    })),
    // --- Illinois: four states, on Form IL-W-5-NR ------------------------
    ...(["IA", "KY", "MI", "WI"] as const).map((residence) => ({
      workRegion: "IL",
      residenceRegion: residence,
      taxedBy: "residence" as const,
      certificateKey: "us_il_ilw5nr",
      // Publication 130 (R-02/26) p. 7: "If your employee does not complete
      // this form, you must withhold Illinois Income Tax."
      withoutCertificate: "work_region" as const,
      // Illinois has no local income taxes, so the question is moot — declared
      // false because that is the fact, not because it is the safe default.
      relievesSubRegionLevies: false,
      citation:
        "Illinois Publication 130 (R-02/26) p. 7 and p. 12; Form IL-W-5-NR (R-12/10)",
    })),
    // --- New Jersey: ONE state, on Form NJ-165 ---------------------------
    // The other half of the PA/NJ pair. Pennsylvania's side (a New Jersey
    // resident working in Pennsylvania, on REV-419) is declared above; this is
    // a Pennsylvania resident working in New Jersey.
    //
    // New Jersey has exactly one reciprocal agreement, and the state it is NOT
    // with is New York. That absence is the assertion this whole tranche was
    // ordered around: a New Jersey resident who works in New York is withheld
    // New York tax in full and takes a CREDIT on the New Jersey return.
    {
      workRegion: "NJ",
      residenceRegion: "PA",
      taxedBy: "residence" as const,
      certificateKey: "us_nj_nj165",
      // NJ-WT p. 8: "You must withhold New Jersey tax if your employee does not
      // complete the certificate."
      withoutCertificate: "work_region" as const,
      // New Jersey has no local wage tax to relieve; declared false as the
      // fact, not as a default.
      relievesSubRegionLevies: false,
      citation:
        "NJ-WT (September 2025) p. 8, \"New Jersey and Pennsylvania Reciprocal Agreement\"; "
        + "Form NJ-165",
    },
    // --- Ohio: five states, on Form IT 4 Section III ----------------------
    ...(["IN", "KY", "MI", "PA", "WV"] as const).map((residence) => ({
      workRegion: "OH",
      residenceRegion: residence,
      taxedBy: "residence" as const,
      // Since 7 December 2020 the waiver lives on the IT 4 itself, which
      // absorbed the old IT 4NR.
      certificateKey: "us_oh_it4",
      withoutCertificate: "work_region" as const,
      // The IT 4's own words are the citation and the limit: "I am not subject
      // to OHIO OR SCHOOL DISTRICT income tax withholding because I am a
      // full-year resident of Indiana, Kentucky, Michigan, Pennsylvania, or
      // West Virginia." It does not mention municipal income tax, and a
      // municipality's tax is not the state's to waive — a Kentucky resident
      // working in Cincinnati pays Cincinnati in full.
      relievesSubRegionLevies: false,
      citation:
        "Ohio Form IT 4 (Rev. 01/24) Section III, Withholding Waiver; Ohio Rev. Code 5747.05(A)"
        + (residence === "PA" ? "; PA Form REV-419, the reciprocal direction" : ""),
    })),
    // --- Michigan: six states, on an employer-kept statement --------------
    // Michigan's agreements are with Illinois, Indiana, Kentucky, Minnesota,
    // Ohio and Wisconsin — SIX, and the two most often left out of a
    // half-remembered list are Minnesota and Illinois. Form 446 (Rev. 02-26)
    // names all six in one sentence.
    ...(["IL", "IN", "KY", "MN", "OH", "WI"] as const).map((residence) => ({
      workRegion: "MI",
      residenceRegion: residence,
      taxedBy: "residence" as const,
      // "Treasury does not furnish nonresidency certificates. The employer may
      // develop a form or obtain a letter from the employee … The employer
      // keeps the form as its authority not to withhold Michigan income tax."
      // So there IS a certificate; the state simply does not print it. Naming
      // it keeps the agreement from applying to an employee who merely lives
      // across the border and never said so in writing.
      certificateKey: "us_mi_nonresidency",
      withoutCertificate: "work_region" as const,
      // Michigan's city income taxes are levied by the city under the Uniform
      // City Income Tax Ordinance, and a state reciprocal agreement does not
      // reach them: a Toledo resident working in Detroit still pays Detroit's
      // nonresident tax.
      relievesSubRegionLevies: false,
      citation:
        "Michigan Form 446 (Rev. 02-26) p. 4, \"Reciprocal Agreements\" and \"Certificate of "
        + "Nonresidency\"; Form MI-W4 (Rev. 12-20) line 8b",
    })),
  ],
};

// ===========================================================================
// Publication
// ===========================================================================

/**
 * Exported, not self-registered.
 *
 * These three used to call `registerPayrollCertificates` / `…Withholding` /
 * `…Reciprocity` right here, at the bottom of this file, for their side
 * effect — and NOTHING IMPORTED THIS MODULE outside its own tests, so the
 * registrations never ran in the product and every declaration above was dead.
 * The US pack carries them now (engine/src/payroll/packs.ts), which is the
 * arrangement `filings` and `statutoryRates` already used: a pack member cannot
 * be forgotten, because the type requires it.
 */
export { US_CERTIFICATES, US_RECIPROCITY, US_WITHHOLDING };
