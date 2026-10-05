import assert from "node:assert/strict";
import { test } from "node:test";
import { CommerceError } from "../errors.ts";
import { decidePushOutcome, sellableQuantity } from "./inventory-push.ts";

test("buffer math holds back stock, floors to whole units and never goes negative", () => {
  assert.deepEqual(sellableQuantity("10.0000", "3"), { sellable: "7.0000", pushQuantity: 7 });
  assert.deepEqual(sellableQuantity("2.5000", "3"), { sellable: "0.0000", pushQuantity: 0 });
  assert.deepEqual(sellableQuantity("7.9000", "0"), { sellable: "7.9000", pushQuantity: 7 });
  assert.deepEqual(sellableQuantity("-2.0000", "0"), { sellable: "0.0000", pushQuantity: 0 });
  assert.deepEqual(sellableQuantity("0.0005", "0"), { sellable: "0.0005", pushQuantity: 0 });
});

test("a buffer nobody typed is refused by name instead of pushing a guess", () => {
  assert.throws(
    () => sellableQuantity("10.0000", "many"),
    (error: unknown) => {
      assert.ok(error instanceof CommerceError);
      assert.equal(error.code, "channel_inventory_buffer_invalid");
      assert.match(error.remedy, /buffer/i);
      return true;
    },
  );
});

test("a quantity Shopify cannot hold is refused by name instead of truncated", () => {
  assert.throws(
    () => sellableQuantity("9999999999.0000", "0"),
    (error: unknown) => {
      assert.ok(error instanceof CommerceError);
      assert.equal(error.code, "channel_inventory_quantity_unpushable");
      return true;
    },
  );
});

test("push decisions never overwrite an outside change and skip converged pairs", () => {
  assert.deepEqual(
    decidePushOutcome({ computed: 7, live: 7, pushed: 4, lastShopify: 4 }),
    { action: "converged" },
  );
  assert.deepEqual(
    decidePushOutcome({ computed: 7, live: 4, pushed: 4, lastShopify: 4 }),
    { action: "push", compareQuantity: 4 },
  );
  assert.deepEqual(
    decidePushOutcome({ computed: 7, live: null, pushed: null, lastShopify: null }),
    { action: "push", compareQuantity: null },
  );
  const conflict = decidePushOutcome({ computed: 7, live: 9, pushed: 4, lastShopify: 4 });
  assert.equal(conflict.action, "conflict");
  assert.equal(conflict.live, 9);
});
