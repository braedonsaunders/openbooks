import assert from "node:assert/strict";
import test from "node:test";
import { billingReviewDigest } from "./billing-reviews.ts";

const base = {
  id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  periodEnd: "2026-09-30",
  total: "500.0000",
  lines: [
    { id: "a", amount: "200.0000", quantity: "2.0000", description: "Crew time" },
    { id: "b", amount: "300.0000", quantity: "3.0000", description: null },
  ],
};

/**
 * The digest is what a customer's acceptance binds to: identical content
 * always fingerprints the same, and any change to what the customer was
 * shown — an amount, a quantity, a description, the line set or its order —
 * yields a different fingerprint, so a stale acceptance cannot land.
 */
test("the billing review digest binds to exactly the content shown", () => {
  const digest = billingReviewDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(billingReviewDigest(structuredClone(base)), digest);
  const variants = [
    { ...base, total: "500.0100" },
    { ...base, periodEnd: "2026-10-31" },
    { ...base, lines: [{ ...base.lines[0]!, amount: "199.0000" }, base.lines[1]!] },
    { ...base, lines: [{ ...base.lines[0]!, quantity: "2.5000" }, base.lines[1]!] },
    { ...base, lines: [base.lines[0]!, { ...base.lines[1]!, description: "Materials" }] },
    { ...base, lines: [base.lines[1]!, base.lines[0]!] },
    { ...base, lines: [base.lines[0]!] },
  ];
  for (const variant of variants) assert.notEqual(billingReviewDigest(variant), digest);
});
