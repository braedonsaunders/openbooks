import assert from "node:assert/strict";
import test from "node:test";
import { catalogNativeTable } from "./channel-catalog-match";

test("catalog matching targets families for products and items for variants", () => {
  assert.equal(catalogNativeTable("product"), "item_families");
  assert.equal(catalogNativeTable("variant"), "items");
});
