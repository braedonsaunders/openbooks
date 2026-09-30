import type { PayrollOpeningYtdField } from "../pack-types.ts";

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
 *
 * Québec income-tax withheld rides it for a fourth reason: slip-box
 * reconciliation. The federal `tax_ytd` column is the T4-box-22 money, so
 * without its own carry-in the RL-1 Box E reconciles to the committed
 * stubs alone and understates the year's Québec tax by exactly the prior
 * provider's amount.
 *
 * Employer CPP/CPP2/EI ride it for a fifth reason: the T4 Summary's
 * employer share. The employee-side columns are T4 boxes 16/16A/18, so
 * without their own carry-in the Summary's employer share reconciles to
 * the committed stubs alone and understates the year's employer levies by
 * exactly the prior provider's amounts.
 */
export const CA_OPENING_YTD_FIELDS: readonly PayrollOpeningYtdField[] = [
  {key:"nonPeriodicPensionDeductionsYtd",column:"non_periodic_pension_deductions_ytd",label:"Pension deductions from bonuses before adoption (F4)",help:"RPP/RRSP deductions already taken from non-periodic pay before adoption. Calendar-year bonus history, separate from the averaging window.",ceilingKey:"nonPeriodicYtd"},
  {key:"caAvgIncome",column:"ca_avg_income",label:"Averaging window — Periodic taxable income",help:"Verified periodic taxable income from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgPensionF",column:"ca_avg_pension_f",label:"Averaging window — Periodic pension deductions (F)",help:"Verified periodic pension deductions (f) from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgAlimony",column:"ca_avg_alimony",label:"Averaging window — Alimony deducted (F2)",help:"Verified alimony deducted (f2) from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgUnionDues",column:"ca_avg_union_dues",label:"Averaging window — Periodic union dues (U1)",help:"Verified periodic union dues (u1) from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgF5A",column:"ca_avg_f5_a",label:"Averaging window — Enhanced CPP deductions on periodic pay (F5A)",help:"Verified enhanced cpp deductions on periodic pay (f5a) from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgPe",column:"ca_avg_pe",label:"Averaging window — Periodic pensionable earnings",help:"Verified periodic pensionable earnings from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgIe",column:"ca_avg_ie",label:"Averaging window — Periodic EI insurable earnings",help:"Verified periodic ei insurable earnings from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgQpip",column:"ca_avg_qpip",label:"Averaging window — Periodic QPIP insurable earnings",help:"Verified periodic qpip insurable earnings from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgBonusPe",column:"ca_avg_bonus_pe",label:"Averaging window — Bonus pensionable earnings",help:"Verified bonus pensionable earnings from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgBonusIe",column:"ca_avg_bonus_ie",label:"Averaging window — Bonus EI insurable earnings",help:"Verified bonus ei insurable earnings from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgBonusQpip",column:"ca_avg_bonus_qpip",label:"Averaging window — Bonus QPIP insurable earnings",help:"Verified bonus qpip insurable earnings from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgTaxM",column:"ca_avg_tax_m",label:"Averaging window — Periodic income tax excluding additional tax (M)",help:"Verified periodic income tax excluding additional tax (m) from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgTaxM1",column:"ca_avg_tax_m1",label:"Averaging window — Bonus income tax (M1)",help:"Verified bonus income tax (m1) from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgBonus",column:"ca_avg_bonus",label:"Averaging window — Non-periodic taxable income (B1)",help:"Verified non-periodic taxable income (b1) from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgF4",column:"ca_avg_f4",label:"Averaging window — Pension deductions from bonuses (F4)",help:"Verified pension deductions from bonuses (f4) from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},
  {key:"caAvgF5B",column:"ca_avg_f5_b",label:"Averaging window — Enhanced CPP deductions from bonuses (F5B)",help:"Verified enhanced cpp deductions from bonuses (f5b) from the elected averaging window through the imported-history date. Excludes amounts outside this window. Confirm the complete history in the employer withholding method record."},

  {
    key: "cpp2BonusYtd",
    column: "cpp2_bonus_ytd",
    label: "Enhanced CPP deductions from bonuses",
    help: "Enhanced CPP deductions applied to lump-sum payments before adoption (T4127 factor F5B year-to-date).",
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
  {
    key: "qcTaxYtd",
    column: "qc_tax_ytd",
    label: "Québec income tax withheld before adoption",
    help: "Québec income tax already withheld this year before adoption, as the prior provider's year-to-date report shows it (RL-1 Box E year-to-date). Distinct from federal tax withheld: do not copy the T4-box-22 figure here.",
  },
  {
    key: "employerCppYtd",
    column: "employer_cpp_ytd",
    label: "Employer CPP contributions before adoption",
    help: "Employer CPP contributions already paid this year before adoption, as the prior provider's year-to-date report shows them (T4 Summary employer-share year-to-date). Distinct from the employee CPP: do not copy the T4-box-16 figure here.",
  },
  {
    key: "employerCpp2Ytd",
    column: "employer_cpp2_ytd",
    label: "Employer CPP2 contributions before adoption",
    help: "Employer second additional CPP contributions already paid this year before adoption, as the prior provider's year-to-date report shows them (T4 Summary employer-share year-to-date). Distinct from the employee CPP2: do not copy the T4-box-16A figure here.",
  },
  {
    key: "employerEiYtd",
    column: "employer_ei_ytd",
    label: "Employer EI premiums before adoption",
    help: "Employer EI premiums already paid this year before adoption, as the prior provider's year-to-date report shows them (T4 Summary employer-share year-to-date). Distinct from the withheld EI premiums: do not copy the T4-box-18 figure here.",
  },
  {
    key: "unionDuesYtd",
    column: "union_dues_ytd",
    label: "Union dues withheld before adoption",
    help: "Eligible union dues already withheld this year before adoption. Folds into T4 box 44 and RL-1 box F with the committed stubs.",
  },
];
