import test from "node:test";
import assert from "node:assert/strict";
import {
  SETUP_ENTITY_BY_KEY,
  setupChildEntities,
  setupEntityHref,
  setupEntitiesByGroup,
} from "./registry.ts";
import { setupParentRecordVisible } from "./types.ts";
test("employer EIN history is a source-qualified US state-account child with one native filing workspace home", () => {
  const entity = SETUP_ENTITY_BY_KEY.get("payroll-us-filing-account-employer-lineage")!;
  assert.ok(setupChildEntities("payroll-filing-accounts").includes(entity));
  assert.equal(entity.allowDelete, false);
  assert.equal(entity.hasActive, false);
  assert.equal(entity.featureKey, "payroll");
  assert.equal(
    setupEntityHref(entity),
    "/admin/setup/payroll?tab=filing&setupTab=payroll-us-filing-account-employer-lineage",
  );
  assert.equal(setupEntitiesByGroup().get("workforce")?.includes(entity), false);
  const binding = entity.parentRecords![0]!;
  assert.equal(
    setupParentRecordVisible(binding, { country: "US", program_type: "us_state_sui" }),
    true,
  );
  assert.equal(setupParentRecordVisible(binding, { country: "US", program_type: "us_ein" }), false);
  assert.equal(setupParentRecordVisible(binding, { country: "CA", program_type: "cra_rp" }), false);
  for (const key of [
    "filingAccountId",
    "federalAccountId",
    "subsidiaryId",
    "effectiveFrom",
    "sourceReference",
  ]) {
    assert.equal(entity.fields.find((field) => field.key === key)?.lockedOnEdit, true);
  }
  assert.equal(entity.fields.find((field) => field.key === "subsidiaryId")?.legalEntity, true);
  assert.equal(entity.fields.find((field) => field.key === "changeReason")?.resetOnEdit, true);
});
