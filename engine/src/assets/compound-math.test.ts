import assert from "node:assert/strict";
import test from "node:test";
import { AssetRefusal } from "./asset-refusal.ts";
import {
  apportionProceeds,
  assertComponentAttachable,
  rollUpCompound,
  type ComponentCandidate,
} from "./compound-math.ts";

const asset = (overrides: Partial<ComponentCandidate> & { id: string }): ComponentCandidate => ({
  assetNumber: overrides.id.toUpperCase(),
  subsidiaryId: "sub-a",
  status: "in_service",
  parentAssetId: null,
  childIds: [],
  scheduledBookIds: ["book-primary"],
  ...overrides,
});

function refusedWith(code: string, fn: () => void): void {
  assert.throws(fn, (error: unknown) => error instanceof AssetRefusal && error.code === code);
}

test("a component attaches to a top-level parent in the same entity and books", () => {
  assert.doesNotThrow(() =>
    assertComponentAttachable(asset({ id: "truck" }), asset({ id: "engine" })),
  );
  // A draft without schedules joins any parent; book comparison needs both schedules.
  assert.doesNotThrow(() =>
    assertComponentAttachable(
      asset({ id: "truck" }),
      asset({ id: "engine", status: "draft", scheduledBookIds: [] }),
    ),
  );
});

test("self-reference, cycles and nesting are refused by name", () => {
  refusedWith("component_self", () =>
    assertComponentAttachable(asset({ id: "truck" }), asset({ id: "truck" })),
  );
  refusedWith("component_cycle", () =>
    assertComponentAttachable(
      asset({ id: "engine", parentAssetId: "truck" }),
      asset({ id: "truck", childIds: ["engine"] }),
    ),
  );
  refusedWith("component_nesting", () =>
    assertComponentAttachable(
      asset({ id: "engine", parentAssetId: "truck" }),
      asset({ id: "piston" }),
    ),
  );
  refusedWith("component_nesting", () =>
    assertComponentAttachable(asset({ id: "fleet" }), asset({ id: "truck", childIds: ["engine"] })),
  );
  refusedWith("component_already_attached", () =>
    assertComponentAttachable(
      asset({ id: "truck" }),
      asset({ id: "engine", parentAssetId: "trailer" }),
    ),
  );
});

test("cross-entity, closed and mismatched-book attachments are refused", () => {
  refusedWith("component_cross_subsidiary", () =>
    assertComponentAttachable(
      asset({ id: "truck" }),
      asset({ id: "engine", subsidiaryId: "sub-b" }),
    ),
  );
  refusedWith("component_parent_status", () =>
    assertComponentAttachable(asset({ id: "truck", status: "disposed" }), asset({ id: "engine" })),
  );
  refusedWith("component_parent_status", () =>
    assertComponentAttachable(
      asset({ id: "site", status: "construction" }),
      asset({ id: "engine" }),
    ),
  );
  refusedWith("component_status", () =>
    assertComponentAttachable(
      asset({ id: "truck" }),
      asset({ id: "engine", status: "written_off" }),
    ),
  );
  refusedWith("component_books_mismatch", () =>
    assertComponentAttachable(
      asset({ id: "truck", scheduledBookIds: ["book-primary", "book-tax"] }),
      asset({ id: "engine" }),
    ),
  );
});

test("the roll-up sums cost, accumulated depreciation and carrying value per book exactly", () => {
  const rollup = rollUpCompound([
    {
      assetId: "truck",
      bookId: "primary",
      cost: "50000.00",
      accumulated: "10000.0001",
      carryingValue: "39999.9999",
    },
    {
      assetId: "engine",
      bookId: "primary",
      cost: "15000.10",
      accumulated: "3000.05",
      carryingValue: "12000.05",
    },
    {
      assetId: "truck",
      bookId: "tax",
      cost: "50000",
      accumulated: "20000",
      carryingValue: "30000",
    },
  ]);
  assert.deepEqual(rollup, [
    {
      bookId: "primary",
      cost: "65000.1000",
      accumulated: "13000.0501",
      carryingValue: "52000.0499",
      assets: 2,
    },
    {
      bookId: "tax",
      cost: "50000.0000",
      accumulated: "20000.0000",
      carryingValue: "30000.0000",
      assets: 1,
    },
  ]);
});

test("compound proceeds split by carrying value to the cent and always sum to the price", () => {
  const shares = apportionProceeds("1000.00", [
    { assetId: "truck", carryingValue: "200", cost: "500" },
    { assetId: "engine", carryingValue: "100", cost: "300" },
    { assetId: "tires", carryingValue: "0", cost: "50" },
  ]);
  assert.deepEqual(shares, [
    { assetId: "truck", proceeds: "666.6700" },
    { assetId: "engine", proceeds: "333.3300" },
    { assetId: "tires", proceeds: "0.0000" },
  ]);
  const fallbackToCost = apportionProceeds("90.00", [
    { assetId: "truck", carryingValue: "0", cost: "200" },
    { assetId: "engine", carryingValue: "0", cost: "100" },
  ]);
  assert.deepEqual(
    fallbackToCost.map((share) => share.proceeds),
    ["60.0000", "30.0000"],
  );
  const parentTakesAll = apportionProceeds("10.00", [
    { assetId: "truck", carryingValue: "0", cost: "0" },
    { assetId: "engine", carryingValue: "0", cost: "0" },
  ]);
  assert.deepEqual(
    parentTakesAll.map((share) => share.proceeds),
    ["10.0000", "0.0000"],
  );
  refusedWith("proceeds_precision", () =>
    apportionProceeds("10.005", [{ assetId: "truck", carryingValue: "1", cost: "1" }]),
  );
  refusedWith("proceeds_negative", () =>
    apportionProceeds("-1", [{ assetId: "truck", carryingValue: "1", cost: "1" }]),
  );
});
