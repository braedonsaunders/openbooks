/**
 * The employer-entered rate slots for the local taxes this pack declares but
 * cannot publish.
 *
 * Two of them, and they exist for the same reason Pennsylvania's Act 32 slot
 * does: the jurisdiction sets its own rate, on its own timetable, and no
 * agency publishes an annual list a payroll system could carry without going
 * silently stale. The employer holds the rate — it is on the notice the
 * municipality sent them — so the employer enters it, exactly as they enter an
 * experience-rated SUI rate.
 *
 * The alternative was to carry rates scraped together from the jurisdictions'
 * own sites. That is worse than it sounds. The lists that circulate already
 * disagree with each other — the most widely copied Michigan city table still
 * prints Saginaw at the 1% statutory floor, when Saginaw is one of the four
 * cities the City Income Tax Act authorises above it — and a wrong rate carried
 * as a constant is indistinguishable, downstream, from a right one.
 *
 * What the pack DOES carry for these jurisdictions is everything that does not
 * rot: that they exist, what they are called, who they reach, and which of them
 * are even possible (Michigan's list is closed by statute; Ohio's is not).
 *
 * These slots are declared here rather than in engine/src/payroll/us/rates.ts
 * so that a state's local-tax data lives beside the state's engine.
 */
import type { PayrollStatutoryRateSlot } from "../../statutory-rates.ts";

/**
 * An Ohio municipal income tax rate, per municipality.
 *
 * R.C. Chapter 718 lets a municipality levy up to 1% by ordinance and more with
 * the voters' approval; several hundred do, from 0.5% to about 3%. The
 * Department of Taxation administers the municipal NET PROFITS tax and directs
 * employers to the municipality or to The Finder for withholding rates, so
 * there is no state publication of them to transcribe.
 *
 * ONE rate, not two: an Ohio municipality applies the same rate to residents
 * and to nonresidents working there. What differs between them is the RESIDENCE
 * CREDIT the home municipality may allow against the tax paid to the work
 * municipality — a credit claimed on the municipal return, not a withholding
 * adjustment, and deliberately not modelled here.
 */
const US_OH_MUNICIPAL_SLOT: PayrollStatutoryRateSlot = {
  key: "us_oh_municipal",
  label: "Ohio municipal income tax rate",
  scope: "sub_region",
  systemKeys: ["oh_municipal"],
  regions: ["OH"],
  // The withholding engine already refuses a missing municipal rate by name;
  // the declaration records that refusal here.
  whenUnconfigured: "refuse",
  citation: "Ohio Rev. Code Chapter 718; the municipality's own income tax ordinance",
  variesBecause:
    "Every Ohio municipality sets its own income tax rate by ordinance and changes it on its own "
    + "schedule. The Department of Taxation publishes no annual municipal withholding rate table, "
    + "so a rate carried in a payroll release would be wrong for whichever municipality changed "
    + "after it, with nothing able to tell.",
  fields: [
    {
      key: "rate", label: "Municipal income tax rate", kind: "rate", decimals: 6,
      min: "0", max: "0.05", required: true,
      help: "As a decimal, from the municipality's ordinance or The Finder at tax.ohio.gov: "
        + "0.025 is 2.5%. Ohio municipalities apply one rate to residents and nonresidents alike "
        + "— the difference between them is the residence credit, which is claimed on the "
        + "municipal return, not withheld.",
    },
  ],
};

/**
 * A Michigan city income tax rate and exemption value, per city.
 *
 * The Uniform City Income Tax Ordinance (MCL 141.501 et seq.) fixes the SHAPE —
 * a resident rate, a nonresident rate at half of it, and a per-exemption
 * allowance — and leaves the numbers to the city. Detroit's are published by
 * the Department of Treasury, which administers its tax, and are pack constants
 * in engine/src/payroll/us/states/mi.ts. The other twenty-three publish their
 * own, and this is where the employer records them.
 *
 * The EXEMPTION VALUE is required alongside the rate and that is not padding:
 * Detroit's is $600 a year and Saginaw's is $750, so an engine that assumed one
 * figure would be wrong for the other by the tax on $150 a year, every year,
 * silently.
 */
const US_MI_CITY_SLOT: PayrollStatutoryRateSlot = {
  key: "us_mi_city",
  label: "Michigan city income tax",
  scope: "sub_region",
  systemKeys: ["mi_city"],
  regions: ["MI"],
  // The withholding engine already refuses a missing city rate by name; the
  // declaration records that refusal here.
  whenUnconfigured: "refuse",
  citation:
    "Michigan City Income Tax Act, MCL 141.501 et seq.; the city's own income tax ordinance",
  variesBecause:
    "Each of the twenty-four Michigan cities that levy an income tax sets its own rate and "
    + "exemption value. Only Detroit's are published by the Department of Treasury; the rest are "
    + "published by the city, and the aggregated lists that circulate disagree with each other.",
  fields: [
    {
      key: "residentRate", label: "Resident rate", kind: "rate", decimals: 6,
      min: "0", max: "0.05", required: true,
      help: "As a decimal: 0.01 is the 1% most Michigan cities levy on residents. Detroit is "
        + "0.024 and is carried by the pack, so it does not need entering.",
    },
    {
      key: "nonresidentRate", label: "Non-resident rate", kind: "rate", decimals: 6,
      min: "0", max: "0.05", required: true,
      help: "As a decimal. The City Income Tax Act sets it at half the resident rate, so it is "
        + "0.005 where the resident rate is 0.01 — but enter the city's own figure rather than "
        + "halving, because the statute caps rather than defines it.",
    },
    {
      key: "exemptionPerYear", label: "Annual exemption value", kind: "amount", decimals: 2,
      min: "0", max: "10000", required: true,
      help: "The ANNUAL value of one exemption, from the city's ordinance: $600 in Detroit, $750 "
        + "in Saginaw. The engine divides it by the pay periods in the year.",
    },
  ],
};

/**
 * TriMet and Lane Transit District payroll-tax rates, per district.
 *
 * Oregon's publications set neither rate: 150-206-436 publishes no TriMet or
 * LTD rate, and the districts revise their own (TriMet's and LTD's current
 * Form OQ figures are the districts', not the Department's). The employer
 * holds the rate — it is on the district notice — so the employer enters it,
 * exactly as they enter an experience-rated SUI rate. orTransitWithholding
 * refuses without it and never invents 0.8237% or 0.80%.
 *
 * ONE rate each: the districts assess a flat rate on payroll. These slots
 * drive the employer posting (system key transit_payroll_tax), never a stub
 * deduction.
 */
const US_OR_TRIMET_SLOT: PayrollStatutoryRateSlot = {
  key: "us_or_trimet",
  label: "TriMet transit payroll-tax rate",
  scope: "sub_region",
  systemKeys: ["transit_payroll_tax"],
  regions: ["OR"],
  // orTransitWithholding already refuses a missing district rate by name; the
  // declaration records that refusal here.
  whenUnconfigured: "refuse",
  citation:
    "Oregon Department of Revenue, Form OQ (Oregon Combined Payroll Tax Report); "
    + "Oregon Withholding Tax Formulas, 150-206-436 (Rev. 12-31-25), which publishes no district rate",
  variesBecause:
    "Each transit district sets its own payroll-tax rate on its own schedule. No Department "
    + "publication carries it, so a rate carried in a payroll release would be wrong for whichever "
    + "district moved after it, with nothing able to tell.",
  fields: [
    {
      key: "rate", label: "Transit payroll-tax rate", kind: "rate", decimals: 6,
      min: "0", max: "0.05", required: true,
      help: "As a decimal, from the district's own notice: 0.008 is 0.8%. The rate is "
        + "employer-entered because no Department publication carries it — never copy a "
        + "circulating figure without checking the district.",
    },
  ],
};

const US_OR_LTD_SLOT: PayrollStatutoryRateSlot = {
  key: "us_or_ltd",
  label: "Lane Transit District payroll-tax rate",
  scope: "sub_region",
  systemKeys: ["transit_payroll_tax"],
  regions: ["OR"],
  whenUnconfigured: "refuse",
  citation:
    "Oregon Department of Revenue, Form OQ (Oregon Combined Payroll Tax Report); "
    + "Oregon Withholding Tax Formulas, 150-206-436 (Rev. 12-31-25), which publishes no district rate",
  variesBecause:
    "Each transit district sets its own payroll-tax rate on its own schedule. No Department "
    + "publication carries it, so a rate carried in a payroll release would be wrong for whichever "
    + "district moved after it, with nothing able to tell.",
  fields: [
    {
      key: "rate", label: "Transit payroll-tax rate", kind: "rate", decimals: 6,
      min: "0", max: "0.05", required: true,
      help: "As a decimal, from the district's own notice. The rate is employer-entered "
        + "because no Department publication carries it — never copy a circulating figure "
        + "without checking the district.",
    },
  ],
};

/**
 * Vermont Child Care Contribution employee-share election, per employer.
 *
 * The 0.44% levy itself is pack-published, but the employee's share of it is
 * the employer's own election: up to 25% (0.11%), or nothing (the statutory
 * default — the employer pays all). No Department publication carries an
 * individual employer's election, so the employer enters it here. Absent
 * means employer-pays-all, which prices no employee line rather than
 * refusing: `whenUnconfigured: "zero"`, and the dispatch skips the levy.
 */
const US_VT_CCCE_SLOT: PayrollStatutoryRateSlot = {
  key: "us_vt_ccce",
  label: "Vermont Child Care Contribution employee share",
  scope: "sub_region",
  systemKeys: ["vt_child_care_contribution_employee"],
  regions: ["VT"],
  whenUnconfigured: "zero",
  citation:
    "Vermont Department of Taxes, Child Care Contribution: employers may withhold a maximum of "
    + "25% of the required 0.44% contribution (0.11%) from employee wages (Form WHT-436 instructions)",
  variesBecause:
    "Each employer elects its own employee share (or none) for its own workforce. No publication "
    + "carries that election, so a release-carried figure would withhold one employer's choice from "
    + "another employer's people.",
  fields: [
    {
      key: "rate", label: "Employee share of the contribution", kind: "rate", decimals: 6,
      min: "0", max: "0.0011", required: false,
      help: "As a decimal: 0.0011 withholds the 25% maximum (0.11%) from employee wages. Leave it "
        + "empty and the employer pays the whole 0.44% levy with no employee withholding.",
    },
  ],
};

/**
 * Minnesota Paid Leave assessed premium, per employer.
 *
 * DEED designates each employer's premium (0.88% of covered wages to the
 * Social Security wage base for 2026; 0.66% for notified small employers),
 * so the employer enters its designation here with its small-employer
 * qualification. Everything is required: a run without the assessed rate
 * or the coverage facts refuses rather than accruing zero.
 */
const US_MN_PL_SLOT: PayrollStatutoryRateSlot = {
  key: "us_mn_pl",
  label: "Minnesota Paid Leave premium rate",
  scope: "sub_region",
  systemKeys: ["mn_paid_leave"],
  regions: ["MN"],
  whenUnconfigured: "refuse",
  citation:
    "Minnesota DEED, 2026 Small Employer Premium Rate Designation; quarterly wage detail and "
    + "premium (UIMN Taxes and Premiums)",
  variesBecause:
    "DEED designates the premium per employer (standard versus small-employer rate). No "
    + "publication carries an individual employer's designation, so a release-carried figure would "
    + "price one employer's designation onto another employer's payroll.",
  fields: [
    {
      key: "rate", label: "Assessed premium rate", kind: "rate", decimals: 6,
      min: "0", max: "0.02", required: true,
      help: "As a decimal from the DEED designation: 0.0088 is the 2026 standard 0.88% premium, "
        + "0.0066 the small-employer 0.66%. The employer pays at least half; the rest is the "
        + "elected employee share below.",
    },
    {
      key: "small_employer", label: "DEED-notified small employer", kind: "flag", decimals: 0,
      min: "0", max: "1", required: true,
      help: "Whether DEED notified the employer as a small employer for Paid Leave (30 or fewer "
        + "employees and average wages under the threshold). Record the notice: the quarterly "
        + "wage-detail report prices the reduced rate off it.",
    },
  ],
};

/**
 * Minnesota Paid Leave elected employee share, per employer.
 *
 * The employer deducts at most half the premium (0.44% for 2026) and pays
 * the rest itself; entering 0 means the employer pays the whole premium.
 * Required alongside the assessed rate above: the even statutory split is
 * not a default the engine may assume, so an unentered share refuses.
 */
const US_MN_PLE_SLOT: PayrollStatutoryRateSlot = {
  key: "us_mn_ple",
  label: "Minnesota Paid Leave employee share",
  scope: "sub_region",
  systemKeys: ["mn_paid_leave_employee"],
  regions: ["MN"],
  whenUnconfigured: "refuse",
  citation:
    "Minnesota Paid Leave (Minn. Stat. ch. 268B): the employer pays at least half the premium "
    + "and deducts at most 0.44% from employee wages",
  variesBecause:
    "Each employer elects its own employee share (or nothing) for its own workforce. No "
    + "publication carries that election, so a release-carried figure would withhold one "
    + "employer's choice from another employer's people.",
  fields: [
    {
      key: "rate", label: "Employee share of the premium", kind: "rate", decimals: 6,
      min: "0", max: "0.0044", required: true,
      help: "As a decimal: 0.0044 deducts the 0.44% maximum from employee wages. Enter 0 when the "
        + "employer pays the whole premium.",
    },
  ],
};

export const US_LOCAL_RATE_SLOTS: readonly PayrollStatutoryRateSlot[] = [
  US_OH_MUNICIPAL_SLOT,
  US_MI_CITY_SLOT,
  US_OR_TRIMET_SLOT,
  US_OR_LTD_SLOT,
  US_VT_CCCE_SLOT,
  US_MN_PL_SLOT,
  US_MN_PLE_SLOT,
];
