import assert from "node:assert/strict";
import test from "node:test";
import { AssetRefusal } from "./asset-refusal.ts";
import {
  buildReclassLines,
  planAllocations,
  splitEvenly,
  type PlannedProposal,
} from "./proposal-math.ts";

const proposal = (
  id: string,
  amount: string,
  overrides: Partial<PlannedProposal> = {},
): PlannedProposal => ({
  id,
  amount,
  subsidiaryId: "sub-a",
  currency: "CAD",
  accountId: "acct-clearing",
  postingDate: "2026-07-10",
  departmentId: null,
  projectId: null,
  locationId: null,
  ...overrides,
});

function refusedWith(code: string, fn: () => void): void {
  assert.throws(fn, (error: unknown) => error instanceof AssetRefusal && error.code === code);
}

test("one proposal becomes one asset at exactly its amount", () => {
  assert.deepEqual(planAllocations("asset", [proposal("p1", "4800.00")], [{ amount: "4800" }]), [
    { proposalId: "p1", targetIndex: 0, amount: "4800.0000" },
  ]);
  refusedWith("amount_mismatch", () =>
    planAllocations("asset", [proposal("p1", "4800.00")], [{ amount: "4000" }]),
  );
  refusedWith("single_proposal_required", () =>
    planAllocations("asset", [proposal("p1", "1"), proposal("p2", "1")], [{ amount: "2" }]),
  );
});

test("a split capitalizes every cent of the line across its assets", () => {
  const allocations = planAllocations(
    "split",
    [proposal("p1", "9000.00")],
    [{ amount: "3000" }, { amount: "3000" }, { amount: "3000.00" }],
  );
  assert.deepEqual(
    allocations.map((allocation) => [allocation.targetIndex, allocation.amount]),
    [
      [0, "3000.0000"],
      [1, "3000.0000"],
      [2, "3000.0000"],
    ],
  );
  refusedWith("amount_mismatch", () =>
    planAllocations("split", [proposal("p1", "9000.00")], [{ amount: "3000" }, { amount: "3000" }]),
  );
  refusedWith("split_targets_required", () =>
    planAllocations("split", [proposal("p1", "9000.00")], [{ amount: "9000" }]),
  );
  refusedWith("amount_not_positive", () =>
    planAllocations("split", [proposal("p1", "10")], [{ amount: "10" }, { amount: "0" }]),
  );
});

test("a merge combines several lines of one entity and currency into one asset", () => {
  const merged = planAllocations(
    "merge",
    [proposal("p1", "1000"), proposal("p2", "250.50")],
    [{ amount: "1250.50" }],
  );
  assert.deepEqual(merged, [
    { proposalId: "p1", targetIndex: 0, amount: "1000.0000" },
    { proposalId: "p2", targetIndex: 0, amount: "250.5000" },
  ]);
  refusedWith("amount_mismatch", () =>
    planAllocations(
      "merge",
      [proposal("p1", "1000"), proposal("p2", "250.50")],
      [{ amount: "1250" }],
    ),
  );
  refusedWith("proposals_cross_subsidiary", () =>
    planAllocations(
      "merge",
      [proposal("p1", "1"), proposal("p2", "1", { subsidiaryId: "sub-b" })],
      [{ amount: "2" }],
    ),
  );
  refusedWith("proposals_mixed_currency", () =>
    planAllocations(
      "merge",
      [proposal("p1", "1"), proposal("p2", "1", { currency: "USD" })],
      [{ amount: "2" }],
    ),
  );
  refusedWith("proposals_duplicate", () =>
    planAllocations("merge", [proposal("p1", "1"), proposal("p1", "1")], [{ amount: "2" }]),
  );
});

test("construction in progress takes each proposal at its own amount", () => {
  assert.deepEqual(
    planAllocations(
      "cip",
      [proposal("p1", "700"), proposal("p2", "300")],
      [{ amount: "1000" }],
    ).map((allocation) => allocation.amount),
    ["700.0000", "300.0000"],
  );
});

test("the reclass moves cost from the purchase account to the asset account, never adding any", () => {
  const lines = buildReclassLines([
    {
      sourceAccountId: "acct-clearing",
      targetAccountId: "acct-vehicles",
      amount: "3000",
      departmentId: "dept-ops",
      projectId: null,
      locationId: null,
      memo: "Truck",
    },
    {
      sourceAccountId: "acct-vehicles",
      targetAccountId: "acct-vehicles",
      amount: "1000",
      departmentId: null,
      projectId: null,
      locationId: null,
      memo: "Already capitalized",
    },
  ]);
  assert.deepEqual(lines, [
    {
      accountId: "acct-vehicles",
      amount: "3000.0000",
      departmentId: "dept-ops",
      projectId: null,
      locationId: null,
      memo: "Truck",
    },
    {
      accountId: "acct-clearing",
      amount: "-3000.0000",
      departmentId: "dept-ops",
      projectId: null,
      locationId: null,
      memo: "Truck",
    },
  ]);
  assert.deepEqual(
    buildReclassLines([
      {
        sourceAccountId: "acct-vehicles",
        targetAccountId: "acct-vehicles",
        amount: "1000",
        departmentId: null,
        projectId: null,
        locationId: null,
        memo: "x",
      },
    ]),
    [],
    "no movement when the purchase already debited the asset account",
  );
});

test("even splits deal leftover cents to the first assets and sum to the amount", () => {
  assert.deepEqual(splitEvenly("100.00", 3), ["33.3400", "33.3300", "33.3300"]);
  assert.deepEqual(splitEvenly("0.02", 3), ["0.0100", "0.0100", "0.0000"]);
  refusedWith("split_precision", () => splitEvenly("100.001", 2));
  refusedWith("split_parts_invalid", () => splitEvenly("100", 1));
  refusedWith("amount_not_positive", () => splitEvenly("0", 2));
});
