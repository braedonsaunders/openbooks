import { toUnits } from "../money/money.ts";
import { fromMinorUnits } from "../payments/acceptance.ts";

/** Convert storefront ISO minor units to the ledger's exact four-decimal units. */
export function minorUnitsToLedgerUnits(amountMinor: bigint, currency: string): bigint {
  return toUnits(fromMinorUnits(amountMinor, currency));
}
