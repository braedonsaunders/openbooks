import type { PayrollOpeningYtdField } from "../pack-types.ts";

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

/**
 * Per-EIN carry-in keys (the pack's `accountOpeningBases`). Prior-provider
 * FICA wages and FICA withheld are entered per EIN, and the per-EIN amount
 * is the ONE carry-in every reader uses: the run's Social Security cap,
 * Additional Medicare threshold and Massachusetts FICA subtraction
 * (compute-statutory.ts) read it for the run's employer, and the W-2 lands
 * it on the slip for that EIN (yearend.ts). The legacy employee-only columns
 * they replace are still read where no per-EIN amount exists; the carry-in
 * screen refuses a save that fills both, so no amount counts twice.
 */
export const US_FICA_WAGES_ACCOUNT_BASE = "us_w2_fica_wages";
export const US_FICA_WITHHELD_ACCOUNT_BASE = "us_w2_fica_withheld";

/**
 * Per-state-account SUI carry-in key. It and the per-state SUI carry-in row
 * for the same state are one amount entered in either place: SUI reads
 * their union (compute-statutory.ts), and the carry-in save refuses both
 * holding an amount for one state.
 */
export const US_SUI_ACCOUNT_BASE = "us_sui";
