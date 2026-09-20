/** Pure role bindings for computation-tier conformance cases. */
import type { Role } from "./types.ts";

export const ROLES: readonly Role[] = [
  "ar",
  "ap",
  "bank",
  "revenue",
  "deferredRevenue",
  "recognizedRevenue",
  "contractAsset",
  "inventory",
  "cogs",
  "inventoryAdjustment",
  "inventoryClearing",
  "freight",
  "taxRecoverable",
  "taxPayable",
  "withholdingPayable",
  "fixedAsset",
  "accumulatedDepreciation",
  "impairmentLoss",
  "disposalGainLoss",
  "fxRealizedGainLoss",
  "fxUnrealizedGainLoss",
  "loanPayable",
  "incomeTaxExpense",
  "incomeTaxPayable",
  "deferredTaxAsset",
  "deferredTaxLiability",
  "rouAsset",
  "leaseLiability",
  "leaseExpense",
  "leaseInterestExpense",
  "rouAmortization",
  "investmentInSub",
  "subsidiaryEquity",
  "nciEquity",
  "nciIncome",
  "equityMethodIncome",
  "distributionIncome",
  "goodwill",
  "fairValueAdjustment",
] as const;

/**
 * Deterministic non-UUID ids for computation cases. Readable in a diff, and
 * impossible to confuse with a real account id if one ever leaks across tiers.
 */
export function syntheticRoles(): Record<Role, string> {
  const map = {} as Record<Role, string>;
  for (const role of ROLES) map[role] = `role:${role}`;
  return map;
}

