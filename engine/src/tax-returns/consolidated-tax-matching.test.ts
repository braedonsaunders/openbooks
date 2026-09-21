import assert from "node:assert/strict";
import test from "node:test";
import { fromUnits, toUnits } from "../money/money.ts";
import {
  ConsolidatedTaxMatchingError,
  matchConsolidatedDepreciation,
  matchConsolidatedTaxItems,
  type ConsolidatedTaxMatchingInput,
} from "./consolidated-tax-matching.ts";

test("1.1502-13 Example 4 matches annual seller income, then releases the remaining gain with its attributes", () => {
  // The regulation expressly disregards the half-year convention in this
  // example. These supplied deductions are not production schedule defaults.
  const year3 = matchConsolidatedDepreciation({
    deferredOpening: "50", actualDeduction: "15", recomputedDeduction: "10",
  });
  assert.equal(year3.sellerMatchingAmount, "5.0000");
  assert.deepEqual(year3.sellerMatchingItems, [{ attribute: "ordinary", amount: "5.0000" }]);
  assert.equal(year3.deferredClosing, "45.0000");
  assert.equal(fromUnits(toUnits(year3.actualCorrespondingAmount) + toUnits(year3.sellerMatchingAmount)), "-10.0000");

  const year4 = matchConsolidatedDepreciation({
    deferredOpening: year3.deferredClosing, actualDeduction: "15", recomputedDeduction: "10",
  });
  assert.equal(year4.sellerMatchingAmount, "5.0000");
  assert.equal(year4.deferredClosing, "40.0000");

  // Outside proceeds 110, buyer basis 100, recomputed basis 60. The
  // redetermined attributes come from Example 4(5), not an amount-sign guess.
  const year5 = matchConsolidatedTaxItems({
    deferredOpening: year4.deferredClosing,
    actualCorrespondingItems: [{ attribute: "section1245_ordinary", amount: "10" }],
    recomputedCorrespondingItems: [
      { attribute: "section1245_ordinary", amount: "40" },
      { attribute: "section1231", amount: "10" },
    ],
  });
  assert.equal(year5.sellerMatchingAmount, "40.0000");
  assert.deepEqual(year5.sellerMatchingItems, [
    { attribute: "section1231", amount: "10.0000" },
    { attribute: "section1245_ordinary", amount: "30.0000" },
  ]);
  assert.equal(year5.deferredClosing, "0.0000");
  assert.equal(fromUnits(toUnits(year3.sellerMatchingAmount) + toUnits(year4.sellerMatchingAmount) + toUnits(year5.sellerMatchingAmount)), "50.0000");
});

test("Example 3 partial disposition releases only the corresponding part of the intercompany gain", () => {
  const firstHalf = matchConsolidatedTaxItems({
    deferredOpening: "10",
    actualCorrespondingItems: [{ attribute: "ordinary", amount: "10" }],
    recomputedCorrespondingItems: [{ attribute: "ordinary", amount: "15" }],
  });
  assert.equal(firstHalf.sellerMatchingAmount, "5.0000");
  assert.equal(firstHalf.deferredClosing, "5.0000");
  const secondHalf = matchConsolidatedTaxItems({
    deferredOpening: firstHalf.deferredClosing,
    actualCorrespondingItems: [{ attribute: "ordinary", amount: "10" }],
    recomputedCorrespondingItems: [{ attribute: "ordinary", amount: "15" }],
  });
  assert.equal(secondHalf.deferredClosing, "0.0000");
});

test("a buyer corresponding loss retains its sign when the recomputed item is a gain", () => {
  const result = matchConsolidatedTaxItems({
    deferredOpening: "30",
    actualCorrespondingItems: [{ attribute: "ordinary", amount: "-10" }],
    recomputedCorrespondingItems: [{ attribute: "ordinary", amount: "20" }],
  });
  assert.equal(result.sellerMatchingAmount, "30.0000");
  assert.equal(result.deferredClosing, "0.0000");
});

test("matching a deferred loss does not turn it into gain or clamp it to zero", () => {
  const result = matchConsolidatedDepreciation({
    deferredOpening: "-50", actualDeduction: "10", recomputedDeduction: "15",
  });
  assert.equal(result.sellerMatchingAmount, "-5.0000");
  assert.deepEqual(result.sellerMatchingItems, [{ attribute: "ordinary", amount: "-5.0000" }]);
  assert.equal(result.deferredClosing, "-45.0000");
});

test("exact sub-cent matching conserves a large balance beyond Number precision", () => {
  const opening = "90071992547409.9999";
  const result = matchConsolidatedDepreciation({
    deferredOpening: opening, actualDeduction: "0.0002", recomputedDeduction: "0.0001",
  });
  assert.equal(result.sellerMatchingAmount, "0.0001");
  assert.equal(result.deferredClosing, "90071992547409.9998");
  assert.equal(toUnits(result.sellerMatchingAmount) + toUnits(result.deferredClosing), toUnits(opening));
});

test("vintage list order and grouping cannot change matching or attribute conservation", () => {
  const input: ConsolidatedTaxMatchingInput = {
    deferredOpening: "100.0000",
    actualCorrespondingItems: [
      { attribute: "ordinary", amount: "-12.3456" },
      { attribute: "section1231", amount: "8.7654" },
      { attribute: "ordinary", amount: "-0.0001" },
    ],
    recomputedCorrespondingItems: [
      { attribute: "section1231", amount: "20.0000" },
      { attribute: "ordinary", amount: "-10.0000" },
    ],
  };
  const result = matchConsolidatedTaxItems(input);
  assert.equal(result.sellerMatchingAmount, "13.5803");
  assert.equal(result.deferredClosing, "86.4197");
  assert.deepEqual(result.sellerMatchingItems, [
    { attribute: "ordinary", amount: "2.3457" },
    { attribute: "section1231", amount: "11.2346" },
  ]);
  assert.deepEqual(matchConsolidatedTaxItems({
    ...input,
    actualCorrespondingItems: [...input.actualCorrespondingItems].reverse(),
    recomputedCorrespondingItems: [...input.recomputedCorrespondingItems].reverse(),
  }), result);
  assert.deepEqual(matchConsolidatedTaxItems({
    ...input,
    actualCorrespondingItems: [
      { attribute: "ordinary", amount: "-12.3457" },
      { attribute: "section1231", amount: "8.7654" },
    ],
  }), result);
});

test("explicitly no corresponding items carries the deferred balance without recognition", () => {
  const result = matchConsolidatedTaxItems({
    deferredOpening: "50", actualCorrespondingItems: [], recomputedCorrespondingItems: [],
  });
  assert.equal(result.sellerMatchingAmount, "0.0000");
  assert.equal(result.deferredClosing, "50.0000");
  assert.deepEqual(result.sellerMatchingItems, []);
});

test("missing amounts, coerced numbers and lost precision refuse rather than become zero", () => {
  for (const bad of [undefined, null, 15, "", "1e3", "1,000", "0.00001"]) {
    assert.throws(() => matchConsolidatedDepreciation({
      deferredOpening: "50", actualDeduction: bad as string, recomputedDeduction: "10",
    }), (error: unknown) => error instanceof ConsolidatedTaxMatchingError
      && /actualDeduction.*exact decimal string/.test(error.message));
  }
  assert.throws(() => matchConsolidatedDepreciation({
    deferredOpening: "50", actualDeduction: "-15", recomputedDeduction: "10",
  }), /nonnegative magnitudes.*signed corresponding items/);
});

test("omitted lists and unknown attributes require the missing tax evidence", () => {
  assert.throws(() => matchConsolidatedTaxItems({
    deferredOpening: "50", recomputedCorrespondingItems: [],
  } as unknown as ConsolidatedTaxMatchingInput), /actualCorrespondingItems.*explicit list/);
  assert.throws(() => matchConsolidatedTaxItems({
    deferredOpening: "50",
    actualCorrespondingItems: [{ attribute: " ", amount: "15" }],
    recomputedCorrespondingItems: [],
  }), /redetermined tax attribute.*statutory character/);
});
