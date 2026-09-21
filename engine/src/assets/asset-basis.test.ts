import assert from "node:assert/strict";
import { test } from "node:test";
import { measurePartialDisposal } from "./asset-basis.ts";
import { add } from "../money/money.ts";
test("a homogeneous partial disposal removes cost and accumulated depreciation, not a percentage of proceeds", () => {
  const r = measurePartialDisposal({
    cost: "1000",
    accumulated: "400",
    salvage: "100",
    proceeds: "180",
    portion: { percent: "25" },
  });
  assert.equal(r.removedCost, "250.0000");
  assert.equal(r.removedAccumulated, "100.0000");
  assert.equal(r.removedCarrying, "150.0000");
  assert.equal(r.gainLoss, "30.0000");
  assert.equal(r.remainingCost, "750.0000");
  assert.equal(r.remainingAccumulated, "300.0000");
  assert.equal(r.remainingSalvage, "75.0000");
  assert.equal(r.full, false);
});
test("identified components use their own measured carrying amount", () => {
  const r = measurePartialDisposal({
    cost: "1000",
    accumulated: "400",
    salvage: "100",
    proceeds: "0",
    portion: { cost: "200", accumulated: "150", salvage: "10" },
  });
  assert.equal(r.removedCarrying, "50.0000");
  assert.equal(r.gainLoss, "-50.0000");
  assert.equal(r.remainingAccumulated, "250.0000");
});
test("rounding preserves both sides of every basis exactly", () => {
  for (const percent of ["0.0001", "33.3333", "66.6667", "99.9999", "100"]) {
    const r = measurePartialDisposal({
      cost: "999.9999",
      accumulated: "333.3333",
      salvage: "123.4567",
      proceeds: "0",
      portion: { percent },
    });
    assert.equal(add(r.remainingCost, r.removedCost), "999.9999");
    assert.equal(add(r.remainingAccumulated, r.removedAccumulated), "333.3333");
    assert.equal(add(r.remainingSalvage, r.removedSalvage), "123.4567");
  }
});
test("impossible component measurements and unreadable money refuse", () => {
  const input = {
    cost: "1000",
    accumulated: "400",
    salvage: "100",
    proceeds: "0",
    portion: { percent: "25" },
  };
  for (const percent of ["0", "-1", "100.0001", "1e2", "12,34"])
    assert.throws(() =>
      measurePartialDisposal({ ...input, portion: { percent } }),
    );
  assert.throws(() =>
    measurePartialDisposal({
      ...input,
      portion: { cost: "200", accumulated: "300", salvage: "0" },
    }),
  );
  assert.throws(() =>
    measurePartialDisposal({
      ...input,
      portion: { cost: "900", accumulated: "0", salvage: "0" },
    }),
  );
  assert.throws(() => measurePartialDisposal({ ...input, proceeds: "-1" }));
});
