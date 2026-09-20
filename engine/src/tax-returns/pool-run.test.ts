import assert from "node:assert/strict";
import test from "node:test";
import { legacyPoolDisposition, taxEventRequiresTaxWorkpaper } from "./pool-run-legacy.ts";

test("legacy ordinary disposals do not require a tax workpaper", () => {
  assert.equal(taxEventRequiresTaxWorkpaper("disposed", null), false);
  assert.equal(taxEventRequiresTaxWorkpaper("written_off", null), false);
  assert.equal(taxEventRequiresTaxWorkpaper("disposed", undefined), false);
});

test("native governed lifecycle events require an approved tax workpaper", () => {
  const changeId = "00000000-0000-4000-8000-000000000001";
  assert.equal(taxEventRequiresTaxWorkpaper("disposed", changeId), true);
  assert.equal(taxEventRequiresTaxWorkpaper("written_off", changeId), true);
  assert.equal(taxEventRequiresTaxWorkpaper("partially_disposed", null), true);
  assert.equal(taxEventRequiresTaxWorkpaper("partially_disposed", changeId), true);
  assert.equal(taxEventRequiresTaxWorkpaper("transferred", null), true);
  assert.equal(taxEventRequiresTaxWorkpaper("transferred", changeId), true);
});

test("legacy pool disposition is the lesser of proceeds and the capital-cost cap", () => {
  assert.equal(legacyPoolDisposition("60000.00", "37000.00"), "37000.00");
  assert.equal(legacyPoolDisposition("20000.00", "37000.00"), "20000.00");
  assert.equal(legacyPoolDisposition("37000.00", "37000.00"), "37000.00");
  assert.equal(legacyPoolDisposition(null, "37000.00"), "0");
  assert.equal(legacyPoolDisposition(undefined, "37000.00"), "0");
});
