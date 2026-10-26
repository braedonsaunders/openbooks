import { fromQuantityUnits, toQuantityUnits } from "@openbooks/engine/money/quantity";
import { compareDecimal } from "./exact-decimal";

/** Minimum amended ordered quantity that preserves fulfillment, billing, and cancellation records. */
export function purchaseOrderAmendQuantityFloor(
  quantityFulfilled: string,
  quantityBilled: string,
  quantityCancelled: string,
): string {
  const appliedQuantity =
    compareDecimal(quantityFulfilled, quantityBilled) >= 0 ? quantityFulfilled : quantityBilled;
  return fromQuantityUnits(toQuantityUnits(appliedQuantity) + toQuantityUnits(quantityCancelled));
}
