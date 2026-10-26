import assert from "node:assert/strict";
import test from "node:test";
import {
  customFieldVisible,
  hiddenCustomFieldKeys,
  redactHiddenCustomValues,
  visibleCustomFieldDefs,
  type CustomFieldViewer,
  type CustomFieldVisibilityDef,
} from "./custom-field-visibility";

const clerk: CustomFieldViewer = { roleKeys: ["clerk"], canManageCustomFields: false };
const buyer: CustomFieldViewer = { roleKeys: ["buyer"], canManageCustomFields: false };
const manager: CustomFieldViewer = { roleKeys: ["clerk"], canManageCustomFields: true };

function def(
  key: string,
  config: Record<string, unknown> = {},
): CustomFieldVisibilityDef & { label: string } {
  return { key, label: key, config: config as CustomFieldVisibilityDef["config"] };
}

const open = def("open_note");
const restricted = def("cost_basis", { allowedRoles: ["buyer"] });

test("a field with no audience or an empty audience is open to every role", () => {
  assert.equal(customFieldVisible(open, clerk), true);
  assert.equal(customFieldVisible(def("empty", { allowedRoles: [] }), clerk), true);
  assert.equal(
    customFieldVisible(def("null_config", {}), { roleKeys: [], canManageCustomFields: false }),
    true,
  );
});

test("a restricted field is visible only to a held role listed in its audience", () => {
  assert.equal(customFieldVisible(restricted, buyer), true);
  assert.equal(customFieldVisible(restricted, clerk), false);
  assert.equal(
    customFieldVisible(restricted, { roleKeys: [], canManageCustomFields: false }),
    false,
  );
});

test("managers see every restricted field", () => {
  assert.equal(customFieldVisible(restricted, manager), true);
});

test("a malformed audience restricts the field to managers instead of widening it", () => {
  for (const allowedRoles of ["buyer", null, 7, ["buyer", ""], ["buyer", 3], [" "]]) {
    const malformed = def("malformed", { allowedRoles });
    assert.equal(customFieldVisible(malformed, buyer), false, JSON.stringify(allowedRoles));
    assert.equal(customFieldVisible(malformed, manager), true, JSON.stringify(allowedRoles));
  }
});

test("visible and hidden key sets partition the definitions for a viewer", () => {
  const defs = [open, restricted];
  assert.deepEqual(
    visibleCustomFieldDefs(defs, clerk).map((d) => d.key),
    ["open_note"],
  );
  assert.deepEqual([...hiddenCustomFieldKeys(defs, clerk)], ["cost_basis"]);
  assert.deepEqual(
    visibleCustomFieldDefs(defs, manager).map((d) => d.key),
    ["open_note", "cost_basis"],
  );
  assert.equal(hiddenCustomFieldKeys(defs, manager).size, 0);
});

test("redaction removes hidden values, keeps open and unknown keys, and passes null through", () => {
  const stored = { open_note: "visible", cost_basis: "100.00", source: { system: "import" } };
  assert.deepEqual(redactHiddenCustomValues([open, restricted], clerk, stored), {
    open_note: "visible",
    source: { system: "import" },
  });
  assert.deepEqual(redactHiddenCustomValues([open, restricted], manager, stored), stored);
  assert.equal(redactHiddenCustomValues([open, restricted], clerk, null), null);
  assert.equal(redactHiddenCustomValues([open, restricted], clerk, undefined), undefined);
});
