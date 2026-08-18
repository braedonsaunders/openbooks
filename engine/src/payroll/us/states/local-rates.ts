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

export const US_LOCAL_RATE_SLOTS: readonly PayrollStatutoryRateSlot[] = [
  US_OH_MUNICIPAL_SLOT,
  US_MI_CITY_SLOT,
];
