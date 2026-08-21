/**
 * Indiana withholding declarations — Form WH-4 and the state + 92-county region.
 *
 * Wired by the parent into `jurisdictions.ts`. Do not import this module from
 * the engine; the engine reads answers through `ResolvedCertificate`.
 */
import type { PayrollCertificate } from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import { IN_COUNTIES_2026 } from "./in.ts";

/** Form WH-4, State Form 48845 (R10 / 8-23). */
export const IN_CERTIFICATE: PayrollCertificate = {
  key: "us_in_wh4",
  form: "WH-4",
  label: "Employee's Withholding Exemption and County Status Certificate (Indiana)",
  scope: { level: "region", region: "IN" },
  purpose: "withholding",
  citation:
    "Indiana Form WH-4, State Form 48845 (R10 / 8-23); Departmental Notice #1 "
    + "(R46 / 01-26), Effective Jan. 1, 2026",
  summary:
    "Sets Indiana state and county withholding exemptions and the January-1 county of "
    + "residence and of principal employment. With no WH-4 on file there are no claimed "
    + "exemptions — Departmental Notice #1 does not follow the federal IRC § 3402(n) "
    + "allowance for no withholding.",
  storage: "certificate_rows",
  fields: [
    {
      key: "residence_county",
      label: "Indiana County of Residence as of January 1",
      kind: "code",
      subRegion: { side: "residence" },
      help:
        "The two-digit county code from Departmental Notice #1 (01–92), or blank / "
        + "\"not applicable\" if the employee did not live in Indiana on January 1. "
        + "A move after January 1 does not change the county until the next calendar year.",
    },
    {
      key: "work_county",
      label: "Indiana County of Principal Employment as of January 1",
      kind: "code",
      subRegion: { side: "work" },
      help:
        "The two-digit county code of the Indiana county where the employee principally "
        + "worked on January 1. Used only when the employee resided out of state on "
        + "January 1 — Departmental Notice #1 then withholds that county's rate.",
    },
    {
      key: "personal_exemptions",
      label: "Line 5 — Total personal exemptions",
      kind: "count",
      min: "0", max: "99", default: "0",
      help:
        "The sum of WH-4 lines 1–4 (self, spouse, dependents, age 65 / blind). Worth "
        + "$1,000 a year each (Table A). Default zero: no certificate means no claimed "
        + "exemptions.",
    },
    {
      key: "additional_dependent_exemptions",
      label: "Line 6 — Additional dependent exemptions",
      kind: "count",
      min: "0", max: "99", default: "0",
      help: "Worth $1,500 a year each (Table B). A qualifying dependent child already counted on line 3.",
    },
    {
      key: "first_time_dependent_exemptions",
      label: "Line 7 — First-time additional dependent exemptions",
      kind: "count",
      min: "0", max: "99", default: "0",
      help:
        "Worth $1,500 a year each (Table B). Good only for the calendar year the WH-4 "
        + "claiming it is submitted. A new WH-4 is required each year this is claimed.",
    },
    {
      key: "adopted_dependent_exemptions",
      label: "Line 8 — Adopted qualifying dependent exemptions",
      kind: "count",
      min: "0", max: "99", default: "0",
      help: "Worth $3,000 a year each (Table C). The child must also be counted on lines 3 and 6.",
    },
    {
      key: "additional_state_per_period",
      label: "Line 9 — Additional state withholding per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Added AFTER the 2.95% rate — a flat dollar amount, not a taxable adjustment.",
    },
    {
      key: "additional_county_per_period",
      label: "Line 10 — Additional county withholding per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Added AFTER the county rate. It does not change state withholding.",
    },
    {
      key: "exempt",
      label: "Exempt from Indiana withholding (WH-4MIL / WH-4AFF)",
      kind: "flag",
      help:
        "WH-4MIL military-spouse earned-income exemption, or a WH-4AFF 30-day "
        + "nonresident waiver the employer is honoring. Departmental Notice #1 does "
        + "not otherwise permit a federal-style exempt claim.",
    },
  ],
};

const IN_COUNTY_LEVIES = IN_COUNTIES_2026.map((county) => ({
  code: county.code,
  label: `${county.name} County income tax`,
  kind: "county",
  // Residents on the January-1 residence county; out-of-state January-1
  // residents on the January-1 Indiana work county. Both sides are declared
  // because the notice reaches both populations, at the same published rate.
  reaches: ["resident", "nonresident"] as const,
  rateSource: { kind: "pack" } as const,
  certificateKey: "us_in_wh4",
  citation:
    `Indiana Department of Revenue, Departmental Notice #1 (R46 / 01-26) p. 5 — ${county.name} `
    + `County (code ${county.code}), rate ${county.rate}`
    + (county.changedSinceOct2025 ? ", changed since the Oct. 1, 2025 issue" : ""),
  implemented: true,
}));

export const IN_REGION: PayrollRegionWithholding = {
  region: "IN",
  label: "Indiana income tax",
  implemented: true,
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by Departmental Notice #1: whether an Indiana resident's
  // wages earned entirely outside Indiana must be withheld on by an Indiana
  // employer. Declared unknown rather than guessed.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_in_wh4",
  subRegions: IN_COUNTY_LEVIES,
  // Departmental Notice #1: withhold the January-1 RESIDENCE county when the
  // employee lived in Indiana; otherwise the January-1 Indiana WORK county.
  // `residence_only` is the in-state half of that rule. The out-of-state-worker
  // half is `inApplicableCounty` in states/in.ts — a blank residence county
  // falls through to the work county. Do not switch this to `both` or
  // `higher_rate`: an Indiana resident who works in another Indiana county
  // owes only the residence county.
  subRegionConflictRule: "residence_only",
  citation:
    "Indiana Department of Revenue, Departmental Notice #1 (R46 / 01-26), Effective "
    + "Jan. 1, 2026; Form WH-4, State Form 48845 (R10 / 8-23)",
};
