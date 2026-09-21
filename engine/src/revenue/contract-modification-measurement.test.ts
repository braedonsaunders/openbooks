import assert from "node:assert/strict";
import { test } from "node:test";
import { measureRevenueModificationGroup as measure } from "./contract-modification-measurement.ts";
import { toUnits } from "../money/money.ts";
const old = {
  id: "service",
  allocated: "1200",
  recognized: "300",
  netCredits: "0",
};
const promise = { existingId: "service", ssp: "900", percentComplete: "25" };
test("distinct addition at SSP is separate and does not consume the original remaining allocation", () => {
  const r = measure({
    treatment: "separate",
    considerationChange: "900",
    existing: [],
    promises: [{ ssp: "900", percentComplete: "0" }],
    remainingDistinct: true,
    additionsAtStandalonePrice: true,
  });
  assert.equal(r.newTotal, "900.0000");
  assert.equal(r.promises[0]!.catchUp, "0.0000");
  assert.equal(r.promises[0]!.remaining, "900.0000");
});
test("prospective revision allocates only remaining consideration, leaving earned revenue untouched", () => {
  const r = measure({
    treatment: "prospective",
    considerationChange: "600",
    existing: [old],
    promises: [promise, { ssp: "600", percentComplete: "0" }],
    remainingDistinct: true,
    additionsAtStandalonePrice: false,
  });
  assert.deepEqual(
    r.promises.map((p) => [p.allocated, p.catchUp, p.remaining]),
    [
      ["1200.0000", "0.0000", "900.0000"],
      ["600.0000", "0.0000", "600.0000"],
    ],
  );
  assert.equal(r.newTotal, "1800.0000");
});
test("ASC 606 Example 8 cumulative catch-up: 1,350,000 × 51.2% less 600,000 = 91,200", () => {
  const r = measure({
    treatment: "catch_up",
    considerationChange: "200000",
    existing: [
      {
        id: "building",
        allocated: "1150000",
        recognized: "600000",
        netCredits: "0",
      },
    ],
    promises: [
      { existingId: "building", ssp: "1350000", percentComplete: "51.2" },
    ],
    remainingDistinct: false,
    additionsAtStandalonePrice: false,
  });
  assert.equal(r.promises[0]!.catchUp, "91200.0000");
  assert.equal(r.promises[0]!.remaining, "658800.0000");
});
test("a downward catch-up reverses earned revenue, never silently clamps to zero", () => {
  const r = measure({
    treatment: "catch_up",
    considerationChange: "-400",
    existing: [old],
    promises: [{ ...promise, percentComplete: "20" }],
    remainingDistinct: false,
    additionsAtStandalonePrice: false,
  });
  assert.equal(r.promises[0]!.catchUp, "-140.0000");
  assert.equal(r.promises[0]!.remaining, "640.0000");
});
test("retired promises keep earned amounts and their unearned consideration goes to remaining promises", () => {
  const r = measure({
    treatment: "prospective",
    considerationChange: "0",
    existing: [old],
    promises: [{ ssp: "900", percentComplete: "0" }],
    remainingDistinct: true,
    additionsAtStandalonePrice: false,
  });
  assert.deepEqual(r.retired, [{ id: "service", allocated: "300" }]);
  assert.equal(r.newTotal, "1200.0000");
  assert.equal(r.promises[0]!.remaining, "900.0000");
});
test("deferred credits are netted once, and fractional allocations conserve every money unit", () => {
  for (const total of ["0.0001", "0.0011", "9999.9999"]) {
    const r = measure({
      treatment: "prospective",
      considerationChange: total,
      existing: [{ ...old, allocated: "300.0001", netCredits: "0.0001" }],
      promises: [
        promise,
        { ssp: "1", percentComplete: "0" },
        { ssp: "3", percentComplete: "0" },
      ],
      remainingDistinct: true,
      additionsAtStandalonePrice: false,
    });
    assert.equal(
      r.promises.reduce((n, p) => n + toUnits(p.remaining), 0n),
      toUnits(total),
    );
    assert.ok(r.promises.every((p) => toUnits(p.catchUp) === 0n));
  }
});
test("inconsistent classifications, duplicate identities, unknown promises and imprecise money refuse", () => {
  const base = {
    treatment: "prospective" as const,
    considerationChange: "0",
    existing: [old],
    promises: [promise],
    remainingDistinct: true,
    additionsAtStandalonePrice: false,
  };
  for (const patch of [
    { remainingDistinct: false },
    { promises: [promise, promise] },
    { promises: [{ ...promise, existingId: "another" }] },
    { considerationChange: "1.00001" },
    { considerationChange: "-1000" },
    { promises: [{ ...promise, percentComplete: "101" }] },
  ])
    assert.throws(() => measure({ ...base, ...patch }));
  assert.throws(
    () => measure({ ...base, treatment: "separate" }),
    /separate contract/,
  );
  assert.throws(
    () => measure({ ...base, treatment: "catch_up" }),
    /non-distinct/,
  );
});
