import type { SqlExecutor } from "../platform/db.ts";
import { convertLaborWage } from "../projects/labor-costing.ts";
import { PayrollError } from "./error.ts";
import { resolvePayrollFxSource } from "./run-calculation-support.ts";
import { resolveBankPayDateValuation } from "./run-bank-valuation.ts";

/** Convert a dated native labor wage into the currency used for a pay run. */
export function entitlementWageInCurrency(input: {
  wage: string;
  fromCurrency: string;
  toCurrency: string;
  payDate: string;
  fxRate: string | null;
}): string {
  if (!input.fromCurrency || !input.toCurrency) {
    throw new PayrollError(
      "The entitlement wage or pay run has no currency — correct Payroll Setup before calculating.",
    );
  }
  if (input.fromCurrency === input.toCurrency) return input.wage;
  if (!input.fxRate) {
    throw new PayrollError(
      `no spot rate for the wage ${input.fromCurrency}→${input.toCurrency} on or before ${input.payDate}` +
        " — enter one before this employee can be paid",
    );
  }
  return convertLaborWage(input.wage, input.fxRate);
}

/** Resolve the wage on the caller's executor and, for pay runs, convert it to cheque currency. */
export async function resolveEntitlementWage(
  executor: SqlExecutor,
  orgId: string,
  employeePartyId: string,
  payDate: string,
  payCurrency?: string,
  lock = false,
): Promise<{ wage: string; currency: string } | null> {
  const valuation = await resolveBankPayDateValuation(
    executor,
    orgId,
    employeePartyId,
    payDate,
    lock,
  );
  if (!valuation) return null;
  if (payCurrency === undefined)
    return { wage: valuation.hourlyWage, currency: valuation.currency };
  if (!payCurrency) {
    throw new PayrollError(
      "The pay run has no currency for entitlement valuation — set its legal-entity currency before calculating.",
    );
  }
  const fx =
    valuation.currency === payCurrency
      ? null
      : await resolvePayrollFxSource(executor, orgId, valuation.currency, payCurrency, payDate);
  return {
    wage: entitlementWageInCurrency({
      wage: valuation.hourlyWage,
      fromCurrency: valuation.currency,
      toCurrency: payCurrency,
      payDate,
      fxRate: fx?.resolvedRate ?? null,
    }),
    currency: payCurrency,
  };
}
