import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTracking } from "./tracking.ts";
import { parseTrackingMode } from "./profile-policy.ts";
import { requiresSecondCount } from "./count-policy.ts";
import { InventoryError } from "./contracts.ts";

test("combined tracking requires both identifiers and exactly one serial unit on every movement leg", () => {
  assert.equal(parseTrackingMode("lot_serial"), "lot_serial");
  for (const leg of ["receipt", "transfer", "pick", "count", "shipment"]) {
    for (const quantity of ["1", "-1"])
      assert.doesNotThrow(() =>
        assertTracking(
          { tracking: "lot_serial" },
          { quantity, lotId: "lot", serialId: "serial" },
          leg,
        ),
      );
    for (const selection of [
      { quantity: "1", lotId: "lot" },
      { quantity: "1", serialId: "serial" },
      { quantity: "2", lotId: "lot", serialId: "serial" },
      { quantity: "0.5", lotId: "lot", serialId: "serial" },
    ])
      assert.throws(
        () => assertTracking({ tracking: "lot_serial" }, selection, leg),
        InventoryError,
      );
  }
});
test("single tracking modes keep refusing extra evidence", () => {
  assert.throws(
    () =>
      assertTracking(
        { tracking: "lot" },
        { quantity: "1", lotId: "lot", serialId: "serial" },
        "receipt",
      ),
    InventoryError,
  );
  assert.throws(
    () =>
      assertTracking(
        { tracking: "serial" },
        { quantity: "1", lotId: "lot", serialId: "serial" },
        "receipt",
      ),
    InventoryError,
  );
  assert.throws(
    () =>
      assertTracking(
        { tracking: "none" },
        { quantity: "1", lotId: "lot" },
        "receipt",
      ),
    InventoryError,
  );
  assert.equal(parseTrackingMode("both"), null);
});
test("second counts are required strictly above the absolute base-unit tolerance in either direction", () => {
  assert.equal(requiresSecondCount("10", "12", "2"), false);
  assert.equal(requiresSecondCount("10", "12.0001", "2"), true);
  assert.equal(requiresSecondCount("10", "7.9999", "2"), true);
  assert.equal(requiresSecondCount("10", "8", "2"), false);
  assert.equal(requiresSecondCount("0", "0", "0"), false);
  assert.equal(requiresSecondCount("0", "0.0001", "0"), true);
  assert.equal(
    requiresSecondCount("999999999999999.9999", "999999999999999.9998", "0"),
    true,
  );
  assert.equal(requiresSecondCount("10", null, "0"), false);
  assert.equal(
    requiresSecondCount("10", "12", null),
    false,
    "historical counts retain their original policy",
  );
});
