/** Pure role bindings for computation-tier conformance cases. */
import type { Role } from "./types.ts";

export const ROLES: readonly Role[] = [
  "ar",
  "ap",
  "bank",
  "vendorPassThrough",
  "revenue",
  "deferredRevenue",
  "recognizedRevenue",
  "contractAsset",
  "grantReceivable",
  "refundableAdvance",
  "grantRevenue",
  "pledgesReceivable",
  "discountOnPledges",
  "pledgeAllowance",
  "contributions",
  "inventory",
  "finishedGoodsInventory",
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
  "provisionExpense",
  "provisionLiability",
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
