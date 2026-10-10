import { add, cmp, neg } from "../money/money.ts";

/** Quantities, revision evidence and lifecycle determine progress; presentation never advances a transaction. */
export function productionJourney(input: {
  status: string; routingVersion: number | null; quantityOrdered: string;
  quantityCompleted: string; quantityScrapped: string; operations: readonly { status: string }[];
}) {
  const terminal = ["done", "closed"].includes(input.status);
  const cancelled = input.status === "cancelled";
  const expected = add(input.quantityOrdered, neg(input.quantityScrapped));
  const remaining = add(expected, neg(input.quantityCompleted));
  const allLoss=!cancelled&&cmp(expected,'0')<=0&&cmp(input.quantityCompleted,'0')===0;
  const receipt = cancelled ? "cancelled" : allLoss ? 'loss' : cmp(input.quantityCompleted, "0") === 0 ? "none"
    : cmp(remaining, "0") <= 0 ? "complete" : terminal ? "shortClosed" : "partial";
  return {
    expected, remaining, receipt,
    planned: !cancelled && input.routingVersion !== null,
    made: !cancelled && input.operations.length > 0 && input.operations.every(op => op.status === "done"),
    received: receipt === "complete", finished: !cancelled && terminal,
    allLoss,blocked: cancelled || input.status === "on_hold" || (allLoss&&!terminal),
  };
}
