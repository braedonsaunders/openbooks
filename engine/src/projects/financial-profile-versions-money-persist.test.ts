import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import {
  assertValidProjectFinancialProfile,
  canonicalizeProjectFinancialProfile,
} from "./financial-profile-versions";

test("trusted numeric policy defaults canonicalize while submitted numeric amounts are refused", () => {
  const builtIn = BUILTIN_PROJECT_TYPES.find((candidate) => candidate.key === "cost_plus");
  assert.ok(builtIn);
  const canonical = canonicalizeProjectFinancialProfile(builtIn.financialProfile);
  assert.equal(canonical.totalPrice.defaultMarkupPercent, "15.0000");
  assert.doesNotThrow(() => assertValidProjectFinancialProfile(canonical));

  const submittedNumber = structuredClone(canonical);
  submittedNumber.totalPrice.defaultMarkupPercent = 15;
  assert.throws(
    () => assertValidProjectFinancialProfile(submittedNumber),
    /totalPrice\.defaultMarkupPercent must be a finite non-negative decimal string/,
  );
});
