import assert from "node:assert/strict";
import test from "node:test";
import { resolveBankEditOffer } from "./self-service";

// The profile bank panel offers Update direct deposit only when the
// employee may actually file it; otherwise the refusal reason shows
// instead of an action the submit would reject.
test("the bank offer needs the self.request grant first", () => {
  assert.equal(resolveBankEditOffer(false, 1), "no-grant");
  assert.equal(resolveBankEditOffer(false, 0), "no-grant");
});

test("the bank offer needs an employment to bind the filing to", () => {
  assert.equal(resolveBankEditOffer(true, 0), "no-employment");
});

test("grant plus employment offers the direct-deposit action", () => {
  assert.equal(resolveBankEditOffer(true, 1), "offer");
  assert.equal(resolveBankEditOffer(true, 3), "offer");
});
