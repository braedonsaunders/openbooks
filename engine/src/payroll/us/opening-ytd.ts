import type { PayrollOpeningYtdField } from "../packs.ts";

/**
 * The US pack's second-order opening year-to-date: history a mid-year
 * adopter's prior provider reports that the BASE opening columns cannot
 * express, because it counts withheld DOLLARS rather than wages.
 *
 * Declared HERE, not in the generic opening-balances layer: the generic code
 * iterates pack declarations and never names a pack's columns. The engine
 * reads this through `usEmployeeYtd`
 * (engine/src/payroll/us/compute-statutory.ts), which references this
 * descriptor's `.column` value rather than repeating the string.
 */
export const US_OPENING_YTD_FIELDS: readonly PayrollOpeningYtdField[] = [
  {
    key: "ficaWithheldYtd",
    column: "fica_withheld_ytd",
    label: "FICA tax withheld",
    help: "Employee Social Security and Medicare tax, including Additional Medicare, already withheld this year (W-2 boxes 4–6). Counts toward the Massachusetts $2,000 retirement-contribution subtraction.",
    ceilingKey: "pensionableYtd",
  },
];
