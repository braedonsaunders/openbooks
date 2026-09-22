import type { PayrollOpeningYtdField } from "../packs.ts";

/**
 * Canada's second-order opening year-to-date fields: history a mid-year
 * adopter's prior provider reports for lump-sum withholding methods but the
 * base statutory columns cannot express. The T4127 bonus method consumes F5B
 * (CPP2 attributed to bonuses); Québec TP-1015 consumes CSB1 (additional QPP
 * attributed to bonuses).
 *
 * Employer-side capped levies ride the same mechanism for a different
 * reason: they run against annual maximums — QPIP employer premiums
 * (T4127 caps them at the year's maxEmployer) and WCB assessable earnings
 * (the worker-comp group's max_assessable) — that committed stubs alone
 * cannot reconstruct for a mid-year adopter. Without a carry-in the first
 * stub re-opens the full annual room and over-accrues burden and liability
 * already paid. Neither has a static ceiling to validate against (both
 * maximums move), so both are ceiling-less: exact money, never negative.
 *
 * The EHT exemption rides it for a third reason: it is employer-level per
 * province, so no single employee's committed stubs can reconstruct what a
 * prior provider already paid either. The carry-in is per-employee
 * remuneration (what the prior provider's YTD report shows); the engine
 * sums it across the employer's in-province carry-ins, so one column serves
 * every EHT province through the employee's current payroll province.
 *
 * These declarations live with the CA pack, not in the generic opening
 * balance layer. The generic layer iterates pack declarations so another
 * country can add its own carry-in facts without country branching here.
 */
export const CA_OPENING_YTD_FIELDS: readonly PayrollOpeningYtdField[] = [
  {
    key: "cpp2BonusYtd",
    column: "cpp2_bonus_ytd",
    label: "CPP2 bonus contributions",
    help: "Second additional CPP contributions withheld on lump-sum payments before adoption (T4127 factor F5B year-to-date).",
    ceilingKey: "nonPeriodicYtd",
  },
  {
    key: "qcCsbYtd",
    column: "qc_csb_ytd",
    label: "Québec additional-QPP bonus contributions",
    help: "Additional QPP (CSB) amounts attributed to lump-sum payments before adoption (TP-1015 factor CSB1 year-to-date, Québec).",
    ceilingKey: "nonPeriodicYtd",
  },
  {
    key: "qpipEmployerYtd",
    column: "qpip_employer_ytd",
    label: "QPIP employer premiums",
    help: "Employer QPIP premiums already paid this year before adoption (Québec). Counts toward the annual employer maximum.",
  },
  {
    key: "wcbAssessableYtd",
    column: "wcb_assessable_ytd",
    label: "WCB assessable earnings",
    help: "Workers' compensation assessable earnings already paid this year before adoption. Counts toward the worker-comp group's annual maximum per employee.",
  },
  {
    key: "ehtRemunerationYtd",
    column: "eht_remuneration_ytd",
    label: "EHT remuneration paid before adoption",
    help: "EHT-subject remuneration already paid this year before adoption (Ontario, British Columbia, Manitoba). Counts toward the employer's annual EHT exemption in the employee's current payroll province.",
  },
];
