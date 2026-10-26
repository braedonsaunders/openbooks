import assert from "node:assert/strict";
import test from "node:test";
import { mrpStockQuantity } from "./mrp.ts";

test("MRP converts eight-place document quantities exactly and accepts a result that fits stock scale", () => {
  assert.deepEqual(
    mrpStockQuantity("0.123456", "case", { case: 100 }, "ea", "Sales order SO-1 line 1"),
    {
      ok: true,
      quantity: "12.3456",
    },
  );
  assert.deepEqual(mrpStockQuantity("2.5", "box", { box: 12 }, "ea", "PO line 2"), {
    ok: true,
    quantity: "30.0000",
  });
  assert.deepEqual(mrpStockQuantity("3", null, {}, "ea", "PO line 3"), {
    ok: true,
    quantity: "3.0000",
  });
});

test("MRP refuses a unit with no configured conversion as not convertible", () => {
  const result = mrpStockQuantity("2", "crate", { box: 12 }, "ea", "Sales order SO-1 line 1");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mrp_unit_not_convertible");
  assert.match(result.message, /Sales order SO-1 line 1 is raised in unit "crate"/);
  assert.match(result.remedy, /unit conversion/);
});

test("MRP refuses a converted quantity that cannot be stored with four places, not as not convertible", () => {
  const result = mrpStockQuantity("0.123456", "ea", {}, "ea", "PO line 1");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mrp_quantity_not_representable");
  assert.match(result.message, /cannot be stored exactly with four decimal places/);

  const tiny = mrpStockQuantity("0.0001", "fraction", { fraction: 0.0001 }, "ea", "PO line 2");
  assert.equal(tiny.ok, false);
  if (tiny.ok) return;
  assert.equal(tiny.code, "mrp_quantity_not_representable");
});

test("MRP refuses a document quantity beyond eight places as not representable", () => {
  const result = mrpStockQuantity("1.123456789", "ea", {}, "ea", "PO line 1");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mrp_quantity_not_representable");
});
