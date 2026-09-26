import assert from "node:assert/strict";
import test from "node:test";

// validateCustomValues is pure. The marker shim matches the repo's
// integration-test convention so the production module loads under node:test.
const { validateCustomValues } = await import("./custom-fields.ts");

const def = {
  key: "flag",
  label: "Flag",
  fieldType: "boolean",
  config: {},
  isRequired: false,
} as never;

test("boolean custom fields reject non-boolean input instead of coercing to false", () => {
  for (const accepted of [true, false, "true", "false"]) {
    const r = validateCustomValues([def], { flag: accepted });
    assert.equal(r.ok, true, `${JSON.stringify(accepted)} is accepted`);
  }
  for (const rejected of ["banana", "yes", "1", 1, 0, {}, []]) {
    const r = validateCustomValues([def], { flag: rejected });
    assert.equal(r.ok, false, `${JSON.stringify(rejected)} is rejected`);
    assert.match(r.errors.flag ?? "", /boolean/, "typed boolean error");
  }
  const stored = validateCustomValues([def], { flag: "false" });
  assert.equal(stored.cleaned.flag, false, "'false' stores false");
});
