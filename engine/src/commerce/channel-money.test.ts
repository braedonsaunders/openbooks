import assert from "node:assert/strict";
import test from "node:test";
import { minorUnitsToLedgerUnits } from "./channel-money.ts";

test("storefront minor units convert to four-decimal ledger units by currency scale", () => {
  assert.equal(minorUnitsToLedgerUnits(10_000n, "CAD"), 1_000_000n);
  assert.equal(minorUnitsToLedgerUnits(10_000n, "JPY"), 100_000_000n);
  assert.equal(minorUnitsToLedgerUnits(10_000n, "BHD"), 100_000n);
});
