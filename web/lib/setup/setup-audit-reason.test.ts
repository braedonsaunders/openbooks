import assert from "node:assert/strict";
import test from "node:test";
import { buildRow, setupAuditReason } from "./coerce.ts";
import { SETUP_ENTITY_BY_KEY } from "./registry.ts";

const component = SETUP_ENTITY_BY_KEY.get("pay-components")!;
const treatment = SETUP_ENTITY_BY_KEY.get("pay-component-statutory-treatments")!;
const treatmentBody = {
  payComponentId: "019f5ea3-44c5-72c0-ad3b-ef34c19c8763",
  effectiveFrom: "2027-01-01",
  programExclusions: [],
  vacationable: false,
};

test("dated component policy saves require fresh audit input without a reason column", () => {
  const reason = treatment.fields.find((field) => field.key === "reason")!;
  assert.equal(reason.required, true);
  assert.equal(reason.inputOnly, true);
  assert.equal(reason.resetOnEdit, true);
  for (const forCreate of [true, false]) {
    assert.ok("error" in buildRow(treatment, treatmentBody, { forCreate }));
    const built = buildRow(
      treatment,
      { ...treatmentBody, reason: "Approved vacation-base policy" },
      { forCreate },
    );
    assert.ok("cols" in built);
    assert.equal(
      built.cols.some((column) => column.column === "reason"),
      false,
    );
    assert.equal(built.cols.find((column) => column.column === "vacationable")?.value, false);
  }
});

test("ordinary component audit input preserves the supplied explanation without inventing one", () => {
  assert.deepEqual(setupAuditReason(component, { name: "Reviewed earning" }), {});
  assert.deepEqual(setupAuditReason(component, { reason: "  Board-approved classification  " }), {
    reason: "Board-approved classification",
  });
  const built = buildRow(
    component,
    { name: "Reviewed earning", reason: "Board-approved classification" },
    { forCreate: false },
  );
  assert.ok("cols" in built);
  assert.deepEqual(built.cols, [{ column: "name", value: "Reviewed earning" }]);
});

test("supplied audit reasons refuse non-text, blank and overlength values on creates and updates", () => {
  for (const reason of [null, true, 123, {}, [], "", "   ", "x".repeat(2001)]) {
    for (const entity of [component, treatment]) {
      assert.ok("error" in setupAuditReason(entity, { reason }));
      for (const forCreate of [true, false]) {
        assert.ok("error" in buildRow(entity, { ...treatmentBody, reason }, { forCreate }));
      }
    }
  }
  assert.deepEqual(setupAuditReason(component, { reason: "x".repeat(2000) }), {
    reason: "x".repeat(2000),
  });
});

test("an explicit audit explanation preserves the stored business reason", () => {
  for (const key of ["payroll-service-credits", "payroll-vacation-terms"]) {
    const entity = SETUP_ENTITY_BY_KEY.get(key)!;
    const body = {
      reason: "Historical credited-service agreement",
      auditReason: "  Approved adoption of retained policy  ",
    };
    assert.deepEqual(setupAuditReason(entity, body), {
      reason: "Approved adoption of retained policy",
    });
    const built = buildRow(entity, body, { forCreate: false });
    assert.ok("cols" in built);
    assert.deepEqual(built.cols, [{ column: "reason", value: body.reason }]);
    for (const auditReason of [null, 12, {}, "", "  ", "x".repeat(2001)])
      assert.ok("error" in setupAuditReason(entity, { ...body, auditReason }));
  }
});
