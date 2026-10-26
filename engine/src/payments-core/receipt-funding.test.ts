import assert from "node:assert/strict";
import test from "node:test";
import { processorReceiptPolicies, receiptPolicyWindowsOverlap } from "./receipt-funding.ts";

const policy = {
  id: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  subsidiaryId: "33333333-3333-4333-8333-333333333333",
  currency: "CAD",
  effectiveFrom: "2026-10-01",
  effectiveTo: "2026-10-31",
};
test("receipt funding windows are inclusive, scoped and refuse malformed stored policy", () => {
  assert.equal(
    receiptPolicyWindowsOverlap(policy, {
      ...policy,
      effectiveFrom: "2026-10-31",
      effectiveTo: null,
    }),
    true,
  );
  assert.equal(
    receiptPolicyWindowsOverlap(policy, {
      ...policy,
      effectiveFrom: "2026-11-01",
      effectiveTo: null,
    }),
    false,
  );
  assert.equal(receiptPolicyWindowsOverlap(policy, { ...policy, currency: "USD" }), false);
  assert.deepEqual(processorReceiptPolicies({ processorReceiptPolicies: [policy] }), [policy]);
  assert.throws(
    () =>
      processorReceiptPolicies({
        processorReceiptPolicies: [{ ...policy, effectiveFrom: "2026-02-30" }],
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      processorReceiptPolicies({
        processorReceiptPolicies: [{ ...policy, effectiveTo: "2026-09-30" }],
      }),
    /invalid/,
  );
});
