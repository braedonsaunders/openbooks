import type { SqlExecutor } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import type { BankCashPayDateValuation } from "./run-bank-cash-evidence.ts";

/**
 * The one pay-date bank valuation a funding split is checked and frozen
 * against: the native wage the entitlement balances value hours at (the
 * projects wage resolver's dated scope selection and hourly conversion),
 * read on the caller's executor so it joins the calculation's transaction,
 * locks and snapshot instead of reopening a current-profile read. The
 * earning-line phase resolves through here before it constructs a split's
 * lines and stamps the result on the bank-funded line; the calculation-
 * source freeze resolves through the same core, so the wage that validates
 * a split is the wage the retained evidence names. The drawdown never
 * re-resolves: it validates the frozen stamp.
 */
export async function resolveBankPayDateValuation(
  executor: SqlExecutor,
  orgId: string,
  employeePartyId: string,
  payDate: string,
  lock: boolean,
): Promise<BankCashPayDateValuation | null> {
  const { laborCostingSettingsInTx, resolveWageValuationInTx } =
    await import("../projects/labor-costing.ts");
  const settings = await laborCostingSettingsInTx(executor, orgId);
  const resolved = await resolveWageValuationInTx(executor, orgId, employeePartyId, payDate, {
    annualHoursDefault: settings.annualHours,
    lock,
  });
  if (!resolved) return null;
  return {
    rateId: resolved.rateId,
    scope: resolved.scope,
    hourlyWage: resolved.wage,
    currency: resolved.currency,
    basis: resolved.basis,
    rate: resolved.rate,
    effectiveFrom: resolved.effectiveFrom,
    effectiveTo: resolved.effectiveTo,
    annualHoursUsed: resolved.annualHoursUsed,
    annualHoursSource: resolved.annualHoursSource,
    updatedAt: resolved.updatedAt,
  };
}

/** Refusal text shared by the line phase and the evidence freeze for an unvalued split. */
export function bankSplitValuationRefusal(employeeName: string, payDate: string): PayrollError {
  return new PayrollError(
    `${employeeName}'s audited bank payout split on the ${payDate} run has no native hourly wage for bank valuation; configure the effective wage and recalculate`,
  );
}
