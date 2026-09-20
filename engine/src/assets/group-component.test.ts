import assert from "node:assert/strict";
import test from "node:test";
import {
  measureGroupComponent,
  transferGroupComponent,
} from "./group-component.ts";
import { groupAssetPlan } from "../money/asset-group-plan.ts";
import { add, mulRatio, neg, toUnits } from "../money/money.ts";
import { splitDepreciationPlan } from "../money/depreciation-plan.ts";
const basis = {
  groupCost: "1000",
  groupAccumulated: "200",
  groupSalvage: "0",
  groupPlan: [
    { startsOn: "2026-07-01", date: "2026-07-31", amount: "310" },
    { startsOn: "2026-08-01", date: "2026-08-31", amount: "490" },
  ],
};
const periods = [
  { starts_on: "2026-07-01", ends_on: "2026-07-31" },
  { starts_on: "2026-08-01", ends_on: "2026-08-31" },
];
const args = {
  basis,
  history: [],
  effectiveOn: "2026-07-16",
  originalBuyerCost: "1200",
  buyerCostBefore: "1200",
  removedBuyerCost: "300",
  onward: true,
  periods,
};
const component = {
  cost: "400",
  accumulated: "100",
  salvage: "0",
  remainingPlan: [
    { date: "2026-07-31", amount: "150" },
    { date: "2026-08-31", amount: "200" },
  ],
  removedPlan: [
    { date: "2026-07-31", amount: "100" },
    { date: "2026-08-31", amount: "200" },
  ],
};
test("identified group component preserves earned depreciation and independently measured remaining cost", () => {
  const event = measureGroupComponent({ ...args, identified: component });
  const state = groupAssetPlan(basis.groupPlan, [event]);
  assert.equal(event.removedCost, "400.0000");
  assert.equal(event.removedAccumulated, "100.0000");
  assert.equal(
    splitDepreciationPlan(state.plan, args.effectiveOn).accrued,
    "150.0000",
    "service before disposal must never be repriced",
  );
  const retained = (v: string) => mulRatio(v, toUnits("900"), toUnits("1200"));
  assert.equal(
    retained(add(basis.groupCost, state.costDelta)),
    "600.0000",
    "the group removes 400 although the buyer removes 25 percent",
  );
  assert.equal(
    retained(add(add(basis.groupAccumulated, state.accumulatedDelta), "150")),
    "250.0000",
  );
  assert.equal(
    retained(
      splitDepreciationPlan(state.plan, args.effectiveOn).remaining.reduce(
        (n, l) => add(n, l.amount),
        "0",
      ),
    ),
    "350.0000",
  );
  assert.equal(
    event.removedPlan!.reduce((n, l) => add(n, l.amount), "0"),
    "300.0000",
  );
});
test("later homogeneous disposal uses the corrected group component basis, not original book ratios", () => {
  const first = measureGroupComponent({ ...args, identified: component });
  const second = measureGroupComponent({
    ...args,
    history: [first],
    effectiveOn: "2026-08-01",
    buyerCostBefore: "900",
    removedBuyerCost: "450",
  });
  assert.equal(second.removedCost, "300.0000");
  assert.equal(second.removedAccumulated, "200.0000");
  assert.equal(
    second.removedPlan!.reduce((n, l) => add(n, l.amount), "0"),
    "100.0000",
  );
  const state = groupAssetPlan(basis.groupPlan, [first, second]);
  const retained = (v: string) => mulRatio(v, toUnits("450"), toUnits("1200"));
  const accumulated = add(
    add(basis.groupAccumulated, state.accumulatedDelta),
    splitDepreciationPlan(state.plan, "2026-09-01").accrued,
  );
  assert.equal(
    retained(add(add(basis.groupCost, state.costDelta), neg(accumulated))),
    "0.0000",
  );
});
test("identified disposal rejects invented service totals and a mismatched whole-group disposal", () => {
  assert.throws(
    () =>
      measureGroupComponent({
        ...args,
        identified: { ...component, remainingPlan: [] },
      }),
    /exactly allocate/,
  );
  assert.throws(
    () =>
      measureGroupComponent({
        ...args,
        identified: { ...component, removedPlan: [] },
      }),
    /Transferred component group depreciation/,
  );
  assert.throws(
    () =>
      measureGroupComponent({
        ...args,
        identified: { ...component, cost: "1000", accumulated: "350" },
      }),
    /same whole or partial/,
  );
});
test("identified disposal after impairment requires the separate unimpaired component evidence", () => {
  const impairment = {
    effectiveOn: "2026-07-01",
    fullDelta: "-100",
    buyerDelta: "-100",
    heldNumerator: "1200",
    heldDenominator: "1200",
    fullPlan: [
      { startsOn: "2026-07-01", date: "2026-07-31", amount: "310" },
      { startsOn: "2026-08-01", date: "2026-08-31", amount: "390" },
    ],
  };
  const identified = {
    ...component,
    accumulated: "150",
    remainingPlan: [
      { date: "2026-07-31", amount: "150" },
      { date: "2026-08-31", amount: "150" },
    ],
    removedPlan: [
      { date: "2026-07-31", amount: "100" },
      { date: "2026-08-31", amount: "150" },
    ],
  };
  assert.throws(
    () => measureGroupComponent({ ...args, history: [impairment], identified }),
    /unimpaired accumulated depreciation/,
  );
  assert.throws(
    () =>
      measureGroupComponent({
        ...args,
        history: [impairment],
        identified: {
          ...identified,
          unimpairedAccumulated: "100",
          unimpairedRemainingPlan: component.remainingPlan,
        },
      }),
    /Transferred component unimpaired group depreciation/,
    "an onward transfer needs the removed counterfactual as well as the retained one",
  );
  const event = measureGroupComponent({
    ...args,
    history: [impairment],
    identified: {
      ...identified,
      unimpairedAccumulated: "100",
      unimpairedRemainingPlan: component.remainingPlan,
      unimpairedRemovedPlan: component.removedPlan,
    },
  });
  const state = groupAssetPlan(basis.groupPlan, [impairment, event]);
  const counter = mulRatio(
    add(
      add(basis.groupCost, state.costDelta),
      neg(
        add(
          add(basis.groupAccumulated, state.unimpairedAccumulatedDelta),
          splitDepreciationPlan(state.unimpairedPlan, args.effectiveOn).accrued,
        ),
      ),
    ),
    toUnits("900"),
    toUnits("1200"),
  );
  assert.equal(counter, "350.0000");
  const transferred = transferGroupComponent(event, "1", "1");
  assert.equal(transferred.groupAccumulated, "150.0000");
  assert.equal(transferred.groupUnimpaired.accumulatedDelta, "-50.0000");
  const next = measureGroupComponent({
    ...args,
    basis: transferred,
    history: [],
    effectiveOn: "2026-08-01",
    originalBuyerCost: "500",
    buyerCostBefore: "500",
    removedBuyerCost: "250",
  });
  assert.equal(next.removedCost, "200.0000");
  assert.equal(next.removedAccumulated, "125.0000");
  assert.equal(next.removedUnimpairedAccumulated, "100.0000");
  assert.equal(
    next.removedPlan!.reduce((n, l) => add(n, l.amount), "0"),
    "75.0000",
  );
  assert.equal(
    next.removedUnimpairedPlan!.reduce((n, l) => add(n, l.amount), "0"),
    "100.0000",
  );
  const translated = transferGroupComponent(event, "1.25", "1.5");
  assert.equal(translated.groupCost, "480.0000");
  assert.equal(translated.groupUnimpaired.accumulatedDelta, "-60.0000");
  assert.equal(
    translated.groupPlan.reduce((n, l) => add(n, l.amount), "0"),
    "300.0000",
  );
  assert.equal(
    translated.groupUnimpaired.plan.reduce((n, l) => add(n, l.amount), "0"),
    "360.0000",
  );
});
