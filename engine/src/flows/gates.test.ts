import assert from "node:assert/strict";
import test from "node:test";
import { gateSubsidiaryScopeAllows } from "./gates.ts";

const IN_SCOPE = "00000000-0000-4000-8000-000000000001";
const OUT_OF_SCOPE = "00000000-0000-4000-8000-000000000002";

test("restricted gate decisions require the subject subsidiary", () => {
  const allowed = new Set([IN_SCOPE]);

  assert.equal(gateSubsidiaryScopeAllows(allowed, OUT_OF_SCOPE), false);
  assert.equal(gateSubsidiaryScopeAllows(allowed, IN_SCOPE), true);
});

test("unrestricted gate decisions preserve org-wide access", () => {
  assert.equal(gateSubsidiaryScopeAllows(null, OUT_OF_SCOPE), true);
  assert.equal(gateSubsidiaryScopeAllows(undefined, null), true);
});
