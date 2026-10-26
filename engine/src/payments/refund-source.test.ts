import assert from "node:assert/strict";
import test from "node:test";
import { refundDelta, refundSource } from "./refund-source.ts";

test("successive cumulative refund snapshots account only for money not already returned", () => {
  assert.equal(
    refundDelta(
      { basis: "cumulative", amount: "30", currency: "CAD", refundId: "charge:3000" },
      0n,
    ),
    300000n,
  );
  assert.equal(
    refundDelta(
      { basis: "cumulative", amount: "50", currency: "CAD", refundId: "charge:5000" },
      300000n,
    ),
    200000n,
  );
  assert.equal(
    refundDelta(
      { basis: "cumulative", amount: "30", currency: "CAD", refundId: "charge:3000" },
      500000n,
    ),
    0n,
  );
  assert.equal(
    refundDelta(
      { basis: "cumulative", amount: "100", currency: "CAD", refundId: "charge:10000" },
      500000n,
    ),
    500000n,
  );
});

test("incremental provider returns retain their amount and missing evidence stays unresolved", () => {
  assert.equal(
    refundDelta(
      { basis: "incremental", amount: "20", currency: "CAD", refundId: "refund-2" },
      300000n,
    ),
    200000n,
  );
  assert.equal(
    refundDelta({ basis: "cumulative", amount: null, currency: "CAD", refundId: null }, 0n),
    null,
  );
  assert.throws(
    () => refundDelta({ basis: "cumulative", amount: "-1", currency: "CAD", refundId: null }, 0n),
    /cannot be negative/,
  );
  assert.throws(
    () =>
      refundSource({
        provider: "stripe",
        providerEventId: "event",
        attemptId: "attempt",
        refundedAmount: "1,000",
        refundCurrency: "CAD",
        providerRef: null,
      }),
    /exact decimal/,
  );
});
