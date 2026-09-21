import {
  groupAssetPlan,
  type GroupAssetValuation,
  type GroupAssetCounterfactual,
} from "../money/asset-group-plan.ts";
import {
  splitDepreciationPlan,
  type DatedDepreciation,
} from "../money/depreciation-plan.ts";
import {
  add,
  cmp,
  divRate,
  mulRate,
  mulRatio,
  neg,
  toUnits,
} from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { measurePartialDisposal } from "./asset-basis.ts";
export interface GroupComponentInput {
  cost: string;
  accumulated: string;
  salvage: string;
  remainingPlan: { date: string; amount: string }[];
  /** Required for an onward transfer: the disposed component's own service. */
  removedPlan?: { date: string; amount: string }[];
  /** Counterfactual evidence is needed when prior impairment changed service. */
  unimpairedAccumulated?: string;
  unimpairedRemainingPlan?: { date: string; amount: string }[];
  unimpairedRemovedPlan?: { date: string; amount: string }[];
}
/** Carry both measured service histories into the next legal owner. An internal
 * transfer cannot reset the group's IAS 36 impairment-reversal ceiling. */
export function transferGroupComponent(
  component: GroupAssetValuation,
  historicalBuyerRate: string,
  currentSellerRate: string,
) {
  if (
    component.kind !== "component" ||
    component.removedCost === undefined ||
    component.removedAccumulated === undefined ||
    component.removedSalvage === undefined ||
    !component.removedPlan ||
    component.removedUnimpairedAccumulated === undefined ||
    !component.removedUnimpairedPlan
  )
    throw new Error(
      "onward transfer requires the approved component's measured and unimpaired service evidence",
    );
  const translate = (value: string) =>
    mulRate(divRate(value, historicalBuyerRate), currentSellerRate);
  const groupCost = translate(component.removedCost),
    groupAccumulated = translate(component.removedAccumulated),
    groupSalvage = translate(component.removedSalvage),
    unimpairedAccumulated = translate(component.removedUnimpairedAccumulated);
  const plan = (lines: DatedDepreciation[], accumulated: string) =>
    allocate(
      lines.map((line) => ({ ...line, amount: translate(line.amount) })),
      1n,
      1n,
      add(add(groupCost, neg(accumulated)), neg(groupSalvage)),
    );
  return {
    groupCost,
    groupAccumulated,
    groupSalvage,
    groupPlan: plan(component.removedPlan, groupAccumulated),
    groupUnimpaired: {
      accumulatedDelta: add(unimpairedAccumulated, neg(groupAccumulated)),
      plan: plan(component.removedUnimpairedPlan, unimpairedAccumulated),
    },
  };
}
const total = (lines: DatedDepreciation[]) =>
  lines.reduce((n, l) => add(n, l.amount), "0");
function allocate(
  lines: DatedDepreciation[],
  numerator: bigint,
  denominator: bigint,
  target: string,
): DatedDepreciation[] {
  const result = lines.map((l) => ({
    ...l,
    amount: mulRatio(l.amount, numerator, denominator),
  }));
  if (result.length)
    result.at(-1)!.amount = add(target, neg(total(result.slice(0, -1))));
  if (
    result.some((l) => cmp(l.amount, "0") < 0) ||
    cmp(total(result), target) !== 0
  )
    throw new Error(
      "group component plan cannot allocate its measured remaining basis",
    );
  return result;
}
/** IAS 16 component derecognition in the original transfer denomination.
 * The normalized patch preserves earned service while expressing the retained
 * group's independently measured cost/accumulation on the new legal fraction.
 * No group amount is inferred from a legal-book ratio for identified parts. */
export function measureGroupComponent(args: {
  basis: {
    groupCost: string;
    groupAccumulated: string;
    groupSalvage: string;
    groupPlan: DatedDepreciation[];
    groupUnimpaired?: GroupAssetCounterfactual;
  };
  history: GroupAssetValuation[];
  effectiveOn: string;
  originalBuyerCost: string;
  buyerCostBefore: string;
  removedBuyerCost: string;
  identified?: GroupComponentInput;
  onward: boolean;
  periods: { starts_on: string; ends_on: string }[];
}): GroupAssetValuation {
  if (
    args.identified &&
    (args.identified.remainingPlan.length > 1200 ||
      (args.identified.removedPlan?.length ?? 0) > 1200 ||
      (args.identified.unimpairedRemainingPlan?.length ?? 0) > 1200 ||
      (args.identified.unimpairedRemovedPlan?.length ?? 0) > 1200)
  )
    throw new Error(
      "group component plans support at most 1,200 accounting periods",
    );
  const { basis, effectiveOn } = args,
    current = groupAssetPlan(
      basis.groupPlan,
      args.history,
      basis.groupUnimpaired,
    );
  const held = toUnits(args.buyerCostBefore),
    original = toUnits(args.originalBuyerCost),
    removed = toUnits(args.removedBuyerCost),
    after = held - removed;
  if (
    original <= 0n ||
    held <= 0n ||
    held > original ||
    removed <= 0n ||
    after < 0n
  )
    throw new Error(
      "group component requires the current retained legal-book basis",
    );
  const share = (value: string) => mulRatio(value, held, original);
  const fullCost = add(basis.groupCost, current.costDelta),
    fullSalvage = add(basis.groupSalvage, current.salvageDelta);
  const elapsed = splitDepreciationPlan(current.plan, effectiveOn);
  const fullAccumulated = add(
    add(basis.groupAccumulated, current.accumulatedDelta),
    elapsed.accrued,
  );
  const cost = share(fullCost),
    accumulated = share(fullAccumulated),
    salvage = share(fullSalvage);
  const identified = args.identified;
  const portion = identified ?? {
    cost: mulRatio(cost, removed, held),
    accumulated: mulRatio(accumulated, removed, held),
    salvage: mulRatio(salvage, removed, held),
  };
  const measurement = measurePartialDisposal({
    cost,
    accumulated,
    salvage,
    proceeds: "0",
    portion,
  });
  if (measurement.full !== (after === 0n))
    throw new Error(
      "legal and group measurements must both identify the same whole or partial asset",
    );
  const dated = (
    lines: { date: string; amount: string }[],
    target: string,
    label: string,
  ): DatedDepreciation[] => {
    let previous = effectiveOn;
    const plan = lines.map((l) => {
      const p = args.periods.find((p) => p.ends_on === l.date);
      if (
        !p ||
        l.date < previous ||
        canonicalDecimal(l.amount, 4) === null ||
        cmp(l.amount, "0") < 0
      )
        throw new Error(
          `${label} must use distinct book period ends and non-negative exact amounts`,
        );
      const startsOn = p.starts_on < effectiveOn ? effectiveOn : p.starts_on;
      if (startsOn < previous)
        throw new Error(`${label} periods cannot overlap`);
      previous = new Date(Date.parse(l.date + "T00:00:00Z") + 86400000)
        .toISOString()
        .slice(0, 10);
      return { startsOn, date: l.date, amount: l.amount };
    });
    if (cmp(total(plan), target) !== 0)
      throw new Error(
        `${label} must exactly allocate measured carrying value less residual value (${target})`,
      );
    return plan;
  };
  const remainingDep = add(
    add(measurement.remainingCost, neg(measurement.remainingAccumulated)),
    neg(measurement.remainingSalvage),
  );
  const removedDep = add(
    measurement.removedCarrying,
    neg(measurement.removedSalvage),
  );
  const remainingPlan = identified
    ? dated(
        identified.remainingPlan,
        remainingDep,
        "Retained group depreciation",
      )
    : allocate(elapsed.remaining, after, original, remainingDep);
  const removedPlan = identified
    ? args.onward
      ? dated(
          identified.removedPlan ?? [],
          removedDep,
          "Transferred component group depreciation",
        )
      : []
    : allocate(elapsed.remaining, removed, original, removedDep);
  const counterElapsed = splitDepreciationPlan(
    current.unimpairedPlan,
    effectiveOn,
  );
  const fullCounterAccum = add(
    add(basis.groupAccumulated, current.unimpairedAccumulatedDelta),
    counterElapsed.accrued,
  );
  const counterAccum = share(fullCounterAccum);
  const priorImpairment =
    cmp(counterAccum, accumulated) !== 0 ||
    current.unimpairedPlan.length !== current.plan.length ||
    current.unimpairedPlan.some((l, i) => {
      const actual = current.plan[i];
      return (
        !actual ||
        l.startsOn !== actual.startsOn ||
        l.date !== actual.date ||
        cmp(l.amount, actual.amount) !== 0
      );
    });
  let remainingCounterAccum: string, remainingCounterPlan: DatedDepreciation[];
  if (identified && priorImpairment) {
    if (
      identified.unimpairedAccumulated === undefined ||
      !identified.unimpairedRemainingPlan
    )
      throw new Error(
        "record this component's unimpaired accumulated depreciation and retained unimpaired plan to preserve the impairment-reversal ceiling",
      );
    const counter = measurePartialDisposal({
      cost,
      accumulated: counterAccum,
      salvage,
      proceeds: "0",
      portion: {
        cost: measurement.removedCost,
        accumulated: identified.unimpairedAccumulated,
        salvage: measurement.removedSalvage,
      },
    });
    remainingCounterAccum = counter.remainingAccumulated;
    remainingCounterPlan = dated(
      identified.unimpairedRemainingPlan,
      add(
        add(counter.remainingCost, neg(counter.remainingAccumulated)),
        neg(counter.remainingSalvage),
      ),
      "Retained unimpaired group depreciation",
    );
    if (cmp(remainingCounterAccum, measurement.remainingAccumulated) > 0)
      throw new Error(
        "unimpaired component evidence cannot leave a lower retained carrying amount than the impaired group basis",
      );
  } else if (identified) {
    remainingCounterAccum = measurement.remainingAccumulated;
    remainingCounterPlan = remainingPlan;
  } else {
    remainingCounterAccum = mulRatio(counterAccum, after, held);
    remainingCounterPlan = allocate(
      counterElapsed.remaining,
      after,
      original,
      add(
        add(measurement.remainingCost, neg(remainingCounterAccum)),
        neg(measurement.remainingSalvage),
      ),
    );
  }
  const removedUnimpairedAccumulated = add(
    counterAccum,
    neg(remainingCounterAccum),
  );
  if (cmp(removedUnimpairedAccumulated, measurement.removedAccumulated) > 0)
    throw new Error(
      "unimpaired component evidence cannot leave a lower transferred carrying amount than the impaired group basis",
    );
  const removedUnimpairedDep = add(
    add(measurement.removedCost, neg(removedUnimpairedAccumulated)),
    neg(measurement.removedSalvage),
  );
  const removedUnimpairedPlan = !args.onward
    ? []
    : identified
      ? priorImpairment
        ? dated(
            identified.unimpairedRemovedPlan ?? [],
            removedUnimpairedDep,
            "Transferred component unimpaired group depreciation",
          )
        : removedPlan
      : allocate(
          counterElapsed.remaining,
          removed,
          original,
          removedUnimpairedDep,
        );
  const full = (v: string) =>
    after === 0n ? "0" : mulRatio(v, original, after);
  const normalize = (plan: DatedDepreciation[], target: string) =>
    after === 0n ? [] : allocate(plan, original, after, full(target));
  return {
    kind: "component",
    effectiveOn,
    serviceFrom: effectiveOn,
    fullDelta: "0",
    buyerDelta: "0",
    heldNumerator: add(args.buyerCostBefore, neg(args.removedBuyerCost)),
    heldDenominator: args.originalBuyerCost,
    fullCostDelta:
      after === 0n ? "0" : add(full(measurement.remainingCost), neg(fullCost)),
    fullAccumulatedDelta:
      after === 0n
        ? "0"
        : add(full(measurement.remainingAccumulated), neg(fullAccumulated)),
    fullSalvageDelta:
      after === 0n
        ? "0"
        : add(full(measurement.remainingSalvage), neg(fullSalvage)),
    fullUnimpairedAccumulatedDelta:
      after === 0n
        ? "0"
        : add(full(remainingCounterAccum), neg(fullCounterAccum)),
    fullPlan: normalize(remainingPlan, remainingDep),
    fullUnimpairedPlan: normalize(
      remainingCounterPlan,
      total(remainingCounterPlan),
    ),
    removedCost: measurement.removedCost,
    removedAccumulated: measurement.removedAccumulated,
    removedSalvage: measurement.removedSalvage,
    removedPlan,
    removedUnimpairedAccumulated,
    removedUnimpairedPlan,
  };
}
