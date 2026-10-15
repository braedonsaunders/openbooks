import test from "node:test";
import assert from "node:assert/strict";
import { isNaturalPersonPartyKind, PARTY_KINDS } from "./party-kinds.ts";

test("native person and employee identities are natural persons", () => {
  assert.deepEqual(PARTY_KINDS.filter(isNaturalPersonPartyKind), ["person", "employee"]);
  for (const kind of ["company", "customer", "vendor", "Employee", "", undefined, null]) {
    assert.equal(isNaturalPersonPartyKind(kind), false);
  }
});
