import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAcceptedQuantity, ReturnRefusal } from "./returns.ts";

test("accepted return quantities are validated before fee SQL receives them", () => {
  assert.equal(parseAcceptedQuantity("0.00", "Accepted quantity"), "0");
  assert.equal(parseAcceptedQuantity("1.2500", "Accepted quantity"), "1.25");
  assert.throws(
    () => parseAcceptedQuantity("", "Accepted quantity"),
    (error: unknown) => {
      assert.ok(error instanceof ReturnRefusal);
      assert.equal(error.code, "invalid_quantity");
      return true;
    },
  );
  assert.throws(
    () => parseAcceptedQuantity("1.00001", "Accepted quantity"),
    (error: unknown) => {
      assert.ok(error instanceof ReturnRefusal);
      assert.equal(error.code, "invalid_quantity");
      return true;
    },
  );
});
