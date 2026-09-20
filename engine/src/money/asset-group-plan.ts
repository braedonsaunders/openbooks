import { add, neg } from "./money.ts";
import {
  accruedDepreciation,
  type DatedDepreciation,
} from "./depreciation-plan.ts";
/** Group-only valuation workpapers retain the original group's denomination.
 * Each replaces only future service; earned depreciation is never repriced. */
export interface GroupAssetValuation {
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
    delta = "0.0000";
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
    delta = add(delta, event.fullDelta);
  }
  return { plan, accumulatedDelta: neg(delta) };
}
