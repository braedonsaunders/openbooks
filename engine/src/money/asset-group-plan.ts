import { add, neg } from "./money.ts";
import {
  accruedDepreciation,
  type DatedDepreciation,
} from "./depreciation-plan.ts";
/** Group-only valuation workpapers retain the original group's denomination.
 * Each replaces only future service; earned depreciation is never repriced. */
export interface GroupAssetValuation {
  kind?: "valuation" | "component";
  /** Full-equivalent basis corrections after a separately identified disposal.
   * These re-express the retained physical portion; they are not P&L. */
  fullCostDelta?: string;
  fullAccumulatedDelta?: string;
  fullSalvageDelta?: string;
  fullUnimpairedAccumulatedDelta?: string;
  fullUnimpairedPlan?: DatedDepreciation[];
  removedCost?: string;
  removedAccumulated?: string;
  removedSalvage?: string;
  removedPlan?: DatedDepreciation[];
  effectiveOn: string;
  serviceFrom?: string;
  fullDelta: string;
  fullPlan: DatedDepreciation[];
  buyerDelta: string;
  heldNumerator: string;
  heldDenominator: string;
}
export function groupAssetPlan(
  original: DatedDepreciation[],
  valuations: GroupAssetValuation[],
) {
  let plan = original.map((line) => ({ ...line })),
    delta = "0.0000",
    costDelta = "0.0000",
    salvageDelta = "0.0000",
    basisAccumulatedDelta = "0.0000",
    unimpairedAccumulatedDelta = "0.0000";
  let unimpairedPlan = original.map((line) => ({ ...line }));
  for (const event of valuations) {
    const serviceFrom = event.serviceFrom ?? event.effectiveOn;
    const before = plan
      .filter((line) => line.startsOn < serviceFrom)
      .map((line) => {
        if (line.date < serviceFrom) return line;
        return {
          ...line,
          date: new Date(Date.parse(serviceFrom + "T00:00:00Z") - 86400000)
            .toISOString()
            .slice(0, 10),
          amount: accruedDepreciation(line, serviceFrom),
        };
      });
    plan = [...before, ...event.fullPlan];
    costDelta = add(costDelta, event.fullCostDelta ?? "0");
    salvageDelta = add(salvageDelta, event.fullSalvageDelta ?? "0");
    basisAccumulatedDelta = add(
      basisAccumulatedDelta,
      event.fullAccumulatedDelta ?? "0",
    );
    unimpairedAccumulatedDelta = add(
      unimpairedAccumulatedDelta,
      event.fullUnimpairedAccumulatedDelta ?? "0",
    );
    if (event.fullUnimpairedPlan) {
      const retained = unimpairedPlan
        .filter((l) => l.startsOn < serviceFrom)
        .map((l) =>
          l.date < serviceFrom
            ? l
            : {
                ...l,
                date: new Date(
                  Date.parse(serviceFrom + "T00:00:00Z") - 86400000,
                )
                  .toISOString()
                  .slice(0, 10),
                amount: accruedDepreciation(l, serviceFrom),
              },
        );
      unimpairedPlan = [...retained, ...event.fullUnimpairedPlan];
    }
    delta = add(delta, event.fullDelta);
  }
  return {
    plan,
    costDelta,
    salvageDelta,
    accumulatedDelta: add(neg(delta), basisAccumulatedDelta),
    valuationDelta: delta,
    unimpairedPlan,
    unimpairedAccumulatedDelta,
  };
}
