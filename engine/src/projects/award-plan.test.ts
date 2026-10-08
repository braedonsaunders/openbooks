import assert from "node:assert/strict";
import test from "node:test";
import {
  AwardPlanError,
  budgetHoursForLine,
  isHourUnit,
  planQuoteAward,
  type AwardSourceLine,
} from "./award-plan.ts";

function line(overrides: Partial<AwardSourceLine> & Pick<AwardSourceLine, "lineId" | "lineNumber">): AwardSourceLine {
  return {
    description: null,
    itemId: null,
    itemName: null,
    itemKind: null,
    itemUnit: null,
    unit: null,
    quantity: "1",
    amount: "0",
    costAmount: null,
    itemDefaultCost: null,
    fxRate: "1",
    ...overrides,
  };
}

test("hours are budgeted only for labor items or hour-measured lines with a positive quantity", () => {
  assert.equal(isHourUnit(" Hrs. "), true);
  assert.equal(isHourUnit("man-hours"), true);
  assert.equal(isHourUnit("day"), false);
  assert.equal(isHourUnit(null), false);
  const base = { unit: null, itemUnit: null, amount: "100" };
  assert.equal(budgetHoursForLine({ ...base, itemKind: "labor", quantity: "12.5" }), "12.50000000");
  assert.equal(budgetHoursForLine({ ...base, itemKind: "service", unit: "hr", quantity: "3.33333333" }), "3.33333333");
  // A blank line unit falls back to the item's unit of measure.
  assert.equal(budgetHoursForLine({ ...base, itemKind: "service", unit: " ", itemUnit: "Hours", quantity: "4" }), "4.00000000");
  assert.equal(budgetHoursForLine({ ...base, itemKind: "non_inventory", unit: "ea", quantity: "40" }), "0.00000000");
  assert.equal(budgetHoursForLine({ ...base, itemKind: "labor", quantity: "-2" }), "0.00000000");
  assert.equal(budgetHoursForLine({ ...base, itemKind: "labor", quantity: "2", amount: "-50" }), "0.00000000");
});

test("the default plan makes one task per priced line and spreads a discount exactly over its task", () => {
  const plan = planQuoteAward({
    lines: [
      line({ lineId: "a", lineNumber: 1, description: "Site crew\nsecond line of detail", itemKind: "labor", unit: "hr", quantity: "10.33333333", amount: "1033.3333", costAmount: "516.6667" }),
      line({ lineId: "b", lineNumber: 2, itemName: "Copper pipe", itemKind: "non_inventory", unit: "ft", quantity: "150", amount: "300.0000", itemDefaultCost: "1.1234" }),
      line({ lineId: "c", lineNumber: 3, description: "Loyalty discount", amount: "-100.0000" }),
    ],
    usedCodes: new Set(["01"]),
  });
  assert.deepEqual(plan.tasks.map((t) => [t.code, t.name]), [["02", "Site crew"], ["03", "Copper pipe"]]);
  // The discount follows the line it discounts and lands entirely on it.
  assert.deepEqual(plan.lines.map((l) => [l.lineId, l.taskKey]), [["a", "line:a"], ["b", "line:b"], ["c", "line:b"]]);
  const pipe = plan.tasks[1]!;
  assert.equal(pipe.price, "200.0000");
  assert.equal(pipe.cost, "168.5100"); // 150 × 1.1234 from the item's standard cost
  assert.equal(plan.tasks[0]!.hours, "10.3333");
  assert.equal(plan.lines.find((l) => l.lineId === "a")!.hours, "10.33333333");
  assert.equal(plan.lines.find((l) => l.lineId === "c")!.price, "0.0000");
  assert.deepEqual(plan.totals, { hours: "10.33333333", cost: "685.1767", price: "1233.3333" });
  assert.equal(plan.missingCost.length, 0);
});

test("a discount spread over several lines keeps the task total exact and no line negative", () => {
  const plan = planQuoteAward({
    lines: [
      line({ lineId: "a", lineNumber: 1, amount: "100.0000", costAmount: "10" }),
      line({ lineId: "b", lineNumber: 2, amount: "200.0000", costAmount: "10" }),
      line({ lineId: "d", lineNumber: 3, amount: "-0.0001" }),
    ],
    tasks: [{ key: "t", code: "10", name: "Everything" }],
    mapping: [{ lineId: "a", taskKey: "t" }, { lineId: "b", taskKey: "t" }, { lineId: "d", taskKey: "t" }],
  });
  assert.equal(plan.tasks[0]!.price, "299.9999");
  assert.ok(plan.lines.every((l) => !l.price.startsWith("-")));
  assert.equal(plan.lines.reduce((sum, l) => sum + Number(l.price.replace(".", "")), 0), 2999999);
});

test("quote amounts and quote costs convert at the quote's own exchange rate", () => {
  const plan = planQuoteAward({
    lines: [line({ lineId: "a", lineNumber: 1, amount: "1000.0000", costAmount: "400.0000", fxRate: "1.3456789012" })],
  });
  assert.equal(plan.tasks[0]!.price, "1345.6789");
  assert.equal(plan.tasks[0]!.cost, "538.2716");
});

test("a priced line with no cost basis is reported, and a supplied cost settles it", () => {
  const lines = [line({ lineId: "a", lineNumber: 7, description: "Mobilization", amount: "2500.0000" })];
  const open = planQuoteAward({ lines });
  assert.deepEqual(open.missingCost.map((l) => l.lineNumber), [7]);
  const settled = planQuoteAward({ lines, lineCosts: [{ lineId: "a", cost: "0" }] });
  assert.equal(settled.missingCost.length, 0);
  assert.equal(settled.lines[0]!.costSource, "explicit");
  assert.throws(
    () => planQuoteAward({ lines, lineCosts: [{ lineId: "a", cost: "-1" }] }),
    (error: unknown) => error instanceof AwardPlanError && /cannot be negative/.test(error.message),
  );
});

test("merged lines sum their production quantity in one unit and refuse mixed units", () => {
  const lines = [
    line({ lineId: "a", lineNumber: 1, unit: "m", quantity: "12.5", amount: "125", costAmount: "50" }),
    line({ lineId: "b", lineNumber: 2, unit: "M", quantity: "7.5", amount: "75", costAmount: "30" }),
    line({ lineId: "c", lineNumber: 3, itemKind: "labor", unit: "hr", quantity: "6", amount: "600", costAmount: "300" }),
    line({ lineId: "e", lineNumber: 4, unit: "ea", quantity: "2", amount: "20", costAmount: "8" }),
  ];
  const merged = planQuoteAward({
    lines,
    productionQuantities: true,
    tasks: [{ key: "run", code: "01", name: "Cable run" }, { key: "fit", code: "02", name: "Fittings" }],
    mapping: [
      { lineId: "a", taskKey: "run" },
      { lineId: "b", taskKey: "run" },
      { lineId: "c", taskKey: "run" },
      { lineId: "e", taskKey: "fit" },
    ],
  });
  const run = merged.tasks[0]!;
  assert.equal(run.budgetQuantity, "20.00000000");
  assert.equal(run.budgetUnit, "m");
  assert.equal(run.hours, "6.0000");
  assert.equal(merged.lines.find((l) => l.lineId === "c")!.quantity, null);
  assert.throws(
    () => planQuoteAward({
      lines,
      productionQuantities: true,
      tasks: [{ key: "all", code: "01", name: "All" }],
      mapping: lines.map((l) => ({ lineId: l.lineId, taskKey: "all" })),
    }),
    (error: unknown) => error instanceof AwardPlanError && /m and ea/.test(error.message),
  );
});

test("a mapping must cover every line exactly once and every task must carry a line", () => {
  const lines = [
    line({ lineId: "a", lineNumber: 1, amount: "10", costAmount: "1" }),
    line({ lineId: "b", lineNumber: 2, amount: "10", costAmount: "1" }),
  ];
  const tasks = [{ key: "x", code: "01", name: "X" }, { key: "y", code: "02", name: "Y" }];
  assert.throws(
    () => planQuoteAward({ lines, tasks, mapping: [{ lineId: "a", taskKey: "x" }, { lineId: "b", taskKey: "x" }] }),
    /Task 02 has no quote lines/,
  );
  assert.throws(() => planQuoteAward({ lines, tasks, mapping: [{ lineId: "a", taskKey: "x" }] }), /line 2 is not mapped/);
  assert.throws(
    () => planQuoteAward({ lines: [line({ lineId: "d", lineNumber: 1, amount: "-5" })] }),
    /discount with no priced line/,
  );
  assert.throws(
    () => planQuoteAward({
      lines: [line({ lineId: "a", lineNumber: 1, amount: "10", costAmount: "1" }), line({ lineId: "d", lineNumber: 2, amount: "-11" })],
    }),
    /exceeds the priced lines/,
  );
});
