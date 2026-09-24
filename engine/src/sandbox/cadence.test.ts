import assert from "node:assert/strict";
import test from "node:test";
import { validateSandboxCadence } from "./cadence.ts";

test("sandbox cadence accepts supported schedules and an explicit clear", () => {
  assert.equal(validateSandboxCadence("hourly"), "hourly");
  assert.equal(validateSandboxCadence("daily"), "daily");
  assert.equal(validateSandboxCadence("weekly"), "weekly");
  assert.equal(validateSandboxCadence(null), null);
});

test("sandbox cadence refuses unsupported present values instead of clearing", () => {
  for (const value of ["monthly", "hourly ", ""]) {
    assert.throws(() => validateSandboxCadence(value), /invalid sandbox refresh cadence/);
  }
});
