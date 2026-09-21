import assert from "node:assert/strict";
import test from "node:test";
import { fromUnits, toUnits } from "./money.ts";
import { splitMoneyProportionally, type MoneyAllocationPart } from "./allocate-proportional.ts";

test("a one-third disposal conserves both its checkpoint components and its retained basis", () => {
  const parts = [
    { key: "section179", amount: "1250" },
    { key: "bonus", amount: "1250" },
    { key: "regular", amount: "0" },
    { key: "remaining", amount: "1250" },
  ];
  const result = splitMoneyProportionally(parts, "1250");
  assert.deepEqual(result, [
    { key: "bonus", take: "416.6667", keep: "833.3333" },
    { key: "regular", take: "0.0000", keep: "0.0000" },
    { key: "remaining", take: "416.6667", keep: "833.3333" },
    { key: "section179", take: "416.6666", keep: "833.3334" },
  ]);
  assert.equal(fromUnits(result.reduce((sum, row) => sum + toUnits(row.take), 0n)), "1250.0000");
  assert.equal(fromUnits(result.reduce((sum, row) => sum + toUnits(row.keep), 0n)), "2500.0000");
  for (const row of result) {
    assert.equal(toUnits(row.take) + toUnits(row.keep), toUnits(parts.find((part) => part.key === row.key)!.amount));
  }
  assert.deepEqual(splitMoneyProportionally([...parts].reverse(), "1250"), result);
});

test("all and none preserve every component, including explicit zero components", () => {
  const parts = [{ key: "a", amount: "10.1234" }, { key: "b", amount: "0" }, { key: "c", amount: "0.0001" }];
  assert.deepEqual(splitMoneyProportionally(parts, "10.1235"), [
    { key: "a", take: "10.1234", keep: "0.0000" },
    { key: "b", take: "0.0000", keep: "0.0000" },
    { key: "c", take: "0.0001", keep: "0.0000" },
  ]);
  assert.deepEqual(splitMoneyProportionally(parts, "0"), [
    { key: "a", take: "0.0000", keep: "10.1234" },
    { key: "b", take: "0.0000", keep: "0.0000" },
    { key: "c", take: "0.0000", keep: "0.0001" },
  ]);
  assert.deepEqual(splitMoneyProportionally([], "0"), []);
  assert.deepEqual(splitMoneyProportionally([{ key: "zero", amount: "0" }], "0"), [
    { key: "zero", take: "0.0000", keep: "0.0000" },
  ]);
});

test("fractional residue is allocated by size before the key tie-break", () => {
  assert.deepEqual(splitMoneyProportionally([
    { key: "a", amount: "0.0001" }, { key: "z", amount: "0.0002" },
  ], "0.0001"), [
    { key: "a", take: "0.0000", keep: "0.0001" },
    { key: "z", take: "0.0001", keep: "0.0001" },
  ]);
});

test("large amounts and sub-cent targets retain exact component and total conservation", () => {
  const parts = [{ key: "a", amount: "90071992547409.9999" }, { key: "b", amount: "1.0001" }];
  const result = splitMoneyProportionally(parts, "90071992547409.9998");
  assert.equal(result.reduce((sum, row) => sum + toUnits(row.take), 0n), toUnits("90071992547409.9998"));
  for (const row of result) {
    const original = toUnits(parts.find((part) => part.key === row.key)!.amount);
    assert.ok(toUnits(row.take) >= 0n && toUnits(row.keep) >= 0n);
    assert.equal(toUnits(row.take) + toUnits(row.keep), original);
  }
});

test("small exact vectors conserve every representable target without overallocating a component", () => {
  for (const weights of [[1n, 1n, 1n], [1n, 2n, 5n], [0n, 2n, 0n, 1n]]) {
    const parts = weights.map((weight, index) => ({ key: String(index), amount: fromUnits(weight) }));
    const total = weights.reduce((sum, weight) => sum + weight, 0n);
    for (let target = 0n; target <= total; target += 1n) {
      const result = splitMoneyProportionally(parts, fromUnits(target));
      assert.equal(result.reduce((sum, row) => sum + toUnits(row.take), 0n), target);
      assert.equal(result.reduce((sum, row) => sum + toUnits(row.keep), 0n), total - target);
      for (const row of result) {
        const original = toUnits(parts.find((part) => part.key === row.key)!.amount);
        assert.ok(toUnits(row.take) >= 0n && toUnits(row.keep) >= 0n);
        assert.equal(toUnits(row.take) + toUnits(row.keep), original);
      }
    }
  }
});

test("invalid targets and ambiguous component identities refuse without dropping a component", () => {
  const parts = [{ key: "basis", amount: "1" }];
  for (const bad of ["-1", "1.0001", "0.00001", "1e0", "1,0", 1, undefined]) {
    assert.throws(() => splitMoneyProportionally(parts, bad as string), /allocation total/);
  }
  assert.throws(() => splitMoneyProportionally([{ key: "a", amount: "-1" }], "0"), /component a must not be negative/);
  assert.throws(() => splitMoneyProportionally([{ key: "a", amount: "1" }, { key: "a", amount: "2" }], "1"), /component a is declared more than once/);
  assert.throws(() => splitMoneyProportionally([{ key: "", amount: "1" }], "0"), /stable nonempty key/);
  assert.throws(() => splitMoneyProportionally(undefined as unknown as MoneyAllocationPart[], "0"), /explicit component list/);
});
