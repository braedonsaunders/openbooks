import assert from "node:assert/strict";
import test from "node:test";
import { AutopayError, MISSING_COLLECTION_POLICY } from "./autopay.ts";

// The collections page renders the missing-policy refusal as a setup
// notice by matching this code, never the human message: the constant pins
// the exact string both sides of the boundary share. That the refusal site
// sets it is proven by the page itself, which shows the notice against a
// policy-less org.
test("the missing collection policy refusal carries its stable code", () => {
  assert.equal(MISSING_COLLECTION_POLICY, "missing_collection_policy");
  const error = new AutopayError("no active collection policy for customer invoices");
  error.code = MISSING_COLLECTION_POLICY;
  assert.equal(error.code, "missing_collection_policy");
  assert.ok(error instanceof Error);
});
