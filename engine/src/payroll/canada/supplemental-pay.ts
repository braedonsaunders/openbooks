import type { PayrollSupplementalPayTreatment } from "../pack-types.ts";

/**
 * A supplemental-period share is ordinary periodic wages paid in a second
 * run: contributions price on the period-to-date base once per period, and
 * income tax follows the org's method — each run taxed as its own periodic
 * pay by default. The withheld keys are the stub-line system keys the
 * cumulative method subtracts as already-withheld tax
 * (federal T4127 / provincial TP-1015).
 */
export const CA_SUPPLEMENTAL_PAY_TREATMENT: PayrollSupplementalPayTreatment = {
  taxMethods: ["period_cumulative", "per_run"],
  defaultTaxMethod: "per_run",
  federalTaxSystemKeys: ["income_tax"],
  provincialTaxSystemKeys: ["qc_income_tax"],
};
