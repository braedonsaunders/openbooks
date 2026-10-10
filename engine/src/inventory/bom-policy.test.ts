import assert from "node:assert/strict";
import test from "node:test";
import { isAssemblyCapableKind } from "./bom-policy.ts";

test("only assemblies and kits can parent a bill of materials", () => {
  assert.equal(isAssemblyCapableKind("assembly"), true);
  assert.equal(isAssemblyCapableKind("kit"), true);
  for (const kind of ["inventory", "service", "non_inventory", "other_charge", "", null, undefined]) {
    assert.equal(isAssemblyCapableKind(kind), false, `${String(kind)} must not parent a recipe`);
  }
});
