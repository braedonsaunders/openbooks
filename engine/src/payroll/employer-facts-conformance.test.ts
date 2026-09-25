import assert from "node:assert/strict";
import test from "node:test";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";
import { employerFactsFor } from "./employer-facts.ts";
import { requireUsContributorySuiMethod } from "./us/compute-statutory.ts";

test("every country pack publishes exactly its declared employer-fact vocabulary", () => {
  for (const [country, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
    assert.ok(Array.isArray(pack.employerFacts), `${country} must explicitly declare employerFacts`);
    assert.deepEqual(employerFactsFor(country), pack.employerFacts);
    const keys = new Set<string>();
    for (const fact of pack.employerFacts) {
      assert.ok(fact.key && fact.label && fact.refusalReason && fact.legalBasis, `${country} ${fact.key} must be named and sourced`);
      assert.ok(!keys.has(fact.key), `${country} duplicates employer fact ${fact.key}`);
      keys.add(fact.key);
      if (fact.kind === "decimal") {
        assert.ok(Number.isInteger(fact.scale) && fact.scale! >= 0 && fact.scale! <= 10, `${country} ${fact.key} must declare decimal scale`);
      }
      if (fact.kind === "choice") assert.ok((fact.choices?.length ?? 0) > 0, `${country} ${fact.key} must declare choices`);
    }
  }
});

test("US reimbursable SUI account refuses pricing as contributory", () => {
  assert.throws(() => requireUsContributorySuiMethod("reimbursable", "CA"), /benefit-charge liability/);
});
