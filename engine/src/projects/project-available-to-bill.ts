import { add, neg, normalizeMoney } from "../money/money.ts";

/**
 * What a project has available to bill, stated on the basis that governs its
 * billing method.
 *
 * - time_and_materials and cost_plus projects bill the valued work performed:
 *   approved billable time and billable cost lines at their bill rates.
 * - fixed_price projects bill against the contract. Time is not billed at rates,
 *   so the figure is the contract value less what has already been invoiced.
 *   A fixed-price project without a contract value refuses by name instead of
 *   showing zero: the remaining amount is unknown until the contract is entered.
 */
export type AvailableToBill =
  | { basis: "rates"; amount: string }
  | { basis: "contract"; amount: string; contractValue: string; invoicedToDate: string }
  | { basis: "contract_unset"; invoicedToDate: string };

export interface AvailableToBillInput {
  billingMethod: "time_and_materials" | "fixed_price" | "cost_plus";
  /** Valued unbilled work (approved time and billable cost lines at bill rates). */
  ratesRevenue: string;
  /** The project's contract value, or null when none has been entered. */
  contractValue: string | null;
  invoicedToDate: string;
}

export function availableToBill(input: AvailableToBillInput): AvailableToBill {
  if (input.billingMethod !== "fixed_price") {
    return { basis: "rates", amount: input.ratesRevenue };
  }
  const invoicedToDate = normalizeMoney(input.invoicedToDate);
  if (input.contractValue === null) {
    return { basis: "contract_unset", invoicedToDate };
  }
  const contractValue = normalizeMoney(input.contractValue);
  return {
    basis: "contract",
    amount: add(contractValue, neg(invoicedToDate)),
    contractValue,
    invoicedToDate,
  };
}
