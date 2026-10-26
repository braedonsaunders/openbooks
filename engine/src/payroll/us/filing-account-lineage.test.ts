import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  usFilingAccountLineageProblem,
  type UsFilingAccountLineageInput,
} from "./filing-account-lineage.ts";
const input = (): UsFilingAccountLineageInput => ({
  filingAccountId: randomUUID(),
  federalAccountId: randomUUID(),
  subsidiaryId: randomUUID(),
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  sourceReference: "Original state registration letter dated January 1",
  changeReason: "Qualify original federal employer",
});
test("lineage qualification accepts an inclusive evidenced original registration window", () => {
  assert.equal(usFilingAccountLineageProblem(input()), null);
  assert.equal(usFilingAccountLineageProblem({ ...input(), effectiveTo: "2026-01-01" }), null);
});
test("lineage qualification refuses missing owner identity, impossible dates and empty source evidence", () => {
  for (const key of ["filingAccountId", "federalAccountId", "subsidiaryId"] as const) {
    assert.match(
      usFilingAccountLineageProblem({ ...input(), [key]: "" })!,
      /original US state filing account/,
    );
  }
  for (const dates of [{ effectiveFrom: "2026-02-30" }, { effectiveTo: "2025-12-31" }]) {
    assert.match(usFilingAccountLineageProblem({ ...input(), ...dates })!, /inclusive dates/);
  }
  for (const key of ["sourceReference", "changeReason"] as const) {
    assert.match(
      usFilingAccountLineageProblem({ ...input(), [key]: "  " })!,
      /evidence reference and a change reason/,
    );
  }
});
