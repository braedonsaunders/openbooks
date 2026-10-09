import assert from "node:assert/strict";
import test from "node:test";
import { apportionWithholdingMaterialsCost, collapseWithholdingLineMetadata } from "./withholding-cost.ts";

test("direct materials cost follows exact child net amounts without losing residual units", () => {
  assert.deepEqual(apportionWithholdingMaterialsCost("300.0001", ["100", "300"]), ["75.0000", "225.0001"]);
  assert.deepEqual(apportionWithholdingMaterialsCost("0", ["100", "300"]), ["0.0000", "0.0000"]);
  assert.deepEqual(apportionWithholdingMaterialsCost(null, ["100", "300"]), [null, null]);
  for (const cost of ["", "3e2", "300.00001", "-1", "401"]) assert.throws(() => apportionWithholdingMaterialsCost(cost, ["100", "300"]));
  assert.throws(() => apportionWithholdingMaterialsCost("300", ["500", "-100"]));
});

test("merging distributions refuses mixed treatment or incomplete costs and preserves an explicit zero", () => {
  assert.throws(() => collapseWithholdingLineMetadata([
    { amount: "100", withholdingTreatment: "labour" }, { amount: "100", withholdingTreatment: "materials", withholdingMaterialsCost: "0" },
  ]), /different withholding treatments/);
  assert.throws(() => collapseWithholdingLineMetadata([
    { amount: "100", withholdingTreatment: "materials", withholdingMaterialsCost: "75" }, { amount: "300", withholdingTreatment: "materials" },
  ]), /every split child/);
  assert.deepEqual(collapseWithholdingLineMetadata([
    { amount: "100", withholdingTreatment: "materials", withholdingMaterialsCost: "0" }, { amount: "300", withholdingTreatment: "materials", withholdingMaterialsCost: "0" },
  ]), { withholdingTreatment: "materials", withholdingMaterialsCost: "0.0000" });
});
