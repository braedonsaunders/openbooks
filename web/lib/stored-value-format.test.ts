import assert from "node:assert/strict";
import test from "node:test";
import { formatStoredValueBreakageRate } from "./stored-value-format.ts";

test("stored-value breakage rates render exact percentage points", () => {
  assert.equal(formatStoredValueBreakageRate("0.0700000000"), "7%");
  assert.equal(formatStoredValueBreakageRate("0.1400000000"), "14%");
  assert.equal(formatStoredValueBreakageRate("0.1234000000"), "12.34%");
  assert.equal(formatStoredValueBreakageRate("0.0001000000"), "0.01%");
});
