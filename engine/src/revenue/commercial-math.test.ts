import assert from "node:assert/strict";
import test from "node:test";
import { calculatedFairValue, allocateRevenueBundle } from "./fair-value.ts";
import {
  earnedRebates,
  selectRebateDeals,
  validateRebateTerms,
  type RebateTerms,
} from "./rebate-math.ts";
import { renewalDue, renewalUnitPrice, renewalTermAmount } from "../billing/renewals.ts";
import { sum } from "../money/money.ts";

const percent: RebateTerms = {
  method: "percent",
  tierBasis: "amount",
  tiers: [
    { threshold: "0", rate: "5" },
    { threshold: "1000", rate: "10" },
  ],
  targetUnitCost: null,
  marginPercent: null,
};
test("formula fair value retains exact percentage and cost-plus boundaries", () => {
  assert.equal(
    calculatedFairValue({
      method: "percent_of_list",
      unitPrice: "0",
      formulaPercent: "33.3333",
      listPrice: "300",
      unitCost: null,
    }),
    "99.9999",
  );
  assert.equal(
    calculatedFairValue({
      method: "cost_plus",
      unitPrice: "0",
      formulaPercent: "25",
      listPrice: null,
      unitCost: "80",
    }),
    "100.0000",
  );
  assert.throws(
    () =>
      calculatedFairValue({
        method: "cost_plus",
        unitPrice: "0",
        formulaPercent: "25",
        listPrice: null,
        unitCost: null,
      }),
    /requires/,
  );
});
test("residual allocation conserves consideration without substituting booked prices for VSOE", () => {
  const elements = [
    { allocation: "normal", ssp: "20", booked: "50", quantity: "2" },
    { allocation: "software", ssp: null, booked: "100", quantity: "1" },
    { allocation: "exclude", ssp: null, booked: "25", quantity: "1" },
  ];
  assert.deepEqual(allocateRevenueBundle(elements), ["40.0000", "110.0000", "25"]);
  assert.equal(sum(allocateRevenueBundle(elements)), "175.0000");
  assert.throws(
    () => allocateRevenueBundle([{ ...elements[0]!, ssp: null }, elements[1]!]),
    /observable VSOE/,
  );
  assert.throws(
    () => allocateRevenueBundle([{ ...elements[0]!, ssp: "100" }, elements[1]!]),
    /exceeds/,
  );
});
test("residual quantities retain eight places at the smallest money boundary", () => {
  assert.deepEqual(
    allocateRevenueBundle([
      { allocation: "normal", ssp: "100000", booked: "1", quantity: "0.00000001" },
      { allocation: "software", ssp: null, booked: "1", quantity: "1" },
    ]),
    ["0.0010", "1.9990"],
  );
});
test("retrospective volume crossing changes earlier earned targets and a return reduces them", () => {
  assert.equal(
    earnedRebates(percent, [{ id: "a", amount: "350", quantity: "1", cost: null }]).get("a"),
    "17.5000",
  );
  const lines = [
    { id: "a", amount: "350", quantity: "1", cost: null },
    { id: "b", amount: "650", quantity: "1", cost: null },
  ];
  assert.deepEqual([...earnedRebates(percent, lines).values()], ["35.0000", "65.0000"]);
  assert.deepEqual(
    [
      ...earnedRebates(percent, [
        ...lines,
        { id: "return", amount: "-100", quantity: "-1", cost: null },
      ]).values(),
    ],
    ["17.5000", "32.5000", "-5.0000"],
  );
  assert.throws(
    () =>
      validateRebateTerms({
        ...percent,
        tiers: [
          { threshold: "1", rate: "5" },
          { threshold: "1", rate: "10" },
        ],
      }),
    /increase strictly/,
  );
});
test("per-unit tiers retain fractional quantities and exact cumulative thresholds", () => {
  const terms = {
    ...percent,
    method: "per_unit" as const,
    tierBasis: "quantity" as const,
    tiers: [
      { threshold: "0", rate: "1000" },
      { threshold: "0.0001", rate: "2000" },
    ],
  };
  assert.equal(
    earnedRebates(terms, [{ id: "a", amount: "1", quantity: "0.00000005", cost: null }]).get("a"),
    "0.0001",
  );
  assert.equal(
    earnedRebates(terms, [{ id: "a", amount: "1", quantity: "0.0001", cost: null }]).get("a"),
    "0.2000",
  );
});
test("fixed cost and margin guarantees require actual measured basis", () => {
  const lines = [{ id: "a", amount: "200", quantity: "2", cost: "160", marginRevenue: "200" }];
  assert.equal(
    earnedRebates({ ...percent, method: "fixed_cost", tiers: [], targetUnitCost: "60" }, lines).get(
      "a",
    ),
    "40.0000",
  );
  assert.equal(
    earnedRebates(
      { ...percent, method: "guaranteed_margin", tiers: [], marginPercent: "30" },
      lines,
    ).get("a"),
    "20.0000",
  );
  assert.throws(
    () =>
      earnedRebates({ ...percent, method: "guaranteed_margin", tiers: [], marginPercent: "30" }, [
        { ...lines[0]!, marginRevenue: null },
      ]),
    /resale revenue/,
  );
  assert.throws(
    () =>
      earnedRebates({ ...percent, method: "fixed_cost", tiers: [], targetUnitCost: "60" }, [
        { ...lines[0]!, cost: null },
      ]),
    /posted inventory cost/,
  );
});
test("stacking combines agreements and best-deal ties resolve stably per counterparty", () => {
  const candidates = [
    {
      agreementId: "z",
      lineId: "line",
      amount: "20",
      stacking: "best" as const,
      selectionGroup: "customer:1",
    },
    {
      agreementId: "a",
      lineId: "line",
      amount: "20",
      stacking: "best" as const,
      selectionGroup: "customer:1",
    },
    {
      agreementId: "s",
      lineId: "line",
      amount: "5",
      stacking: "stack" as const,
      selectionGroup: "customer:1",
    },
    {
      agreementId: "v",
      lineId: "line",
      amount: "30",
      stacking: "best" as const,
      selectionGroup: "vendor:1",
    },
  ];
  assert.deepEqual(
    selectRebateDeals(candidates).map((c) => c.agreementId),
    ["s", "a", "v"],
  );
  assert.deepEqual(
    selectRebateDeals([...candidates].reverse())
      .filter((c) => c.stacking === "best")
      .map((c) => c.agreementId),
    ["a", "v"],
  );
});
test("renewal lead dates, uplift and contract consideration follow the anchored billing cadence", () => {
  assert.equal(renewalDue("2026-11-01", "2026-10-02", 30), true);
  assert.equal(renewalDue("2026-11-01", "2026-11-02", 30), false);
  assert.throws(() => renewalDue("2026-02-30", "2026-02-01", 30), /valid/);
  assert.equal(renewalUnitPrice("199.99", "5"), "209.9895");
  assert.equal(renewalTermAmount("100", "2026-01-31", "2027-01-31", "monthly", 1, 31), "1200.0000");
  assert.equal(renewalTermAmount("100", "2026-01-31", "2026-02-14", "monthly", 1, 31), "50.0000");
});
