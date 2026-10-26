import assert from "node:assert/strict";
import test from "node:test";
import { customFieldColumns, type CustomFieldDefClient } from "./custom-field-inputs";

for (const mode of ["readonly", "disabled"] as const) {
  test(`custom line fields honor ${mode} display mode without losing displayed values`, () => {
    for (const fieldType of [
      "text",
      "long_text",
      "number",
      "currency",
      "date",
      "boolean",
      "select",
      "multi_select",
      "reference",
    ] as const) {
      const def: CustomFieldDefClient = {
        key: "review_value",
        label: "Review value",
        fieldType,
        config: { displayMode: mode, options: ["One", "Two"] },
        isRequired: false,
      };
      const column = customFieldColumns([def])[0]!;
      assert.equal(column.type, "readonly");
      for (const [value, expected] of [
        ["900000000000000.1234", "900000000000000.1234"],
        [false, "false"],
        [["One", "Two"], "One, Two"],
        [null, ""],
      ] as const) {
        assert.equal(column.render?.({ cf_review_value: value }, 0), expected);
      }
    }
  });
}
test("hidden line fields remain absent and normal fields remain editable", () => {
  for (const mode of ["normal", "always", undefined] as const) {
    const columns = customFieldColumns([
      {
        key: "hidden_note",
        label: "Hidden",
        fieldType: "text",
        config: { displayMode: "hidden" },
        isRequired: false,
      },
      {
        key: "note",
        label: "Note",
        fieldType: "text",
        config: { displayMode: mode },
        isRequired: false,
      },
    ]);
    assert.equal(columns.length, 1);
    assert.equal(columns[0]!.key, "cf_note");
    assert.equal(columns[0]!.type, "text");
  }
});

test("line columns for restricted fields render only for a viewer in the audience or a manager", () => {
  const restricted: CustomFieldDefClient = {
    key: "cost_basis",
    label: "Cost basis",
    fieldType: "currency",
    config: { allowedRoles: ["buyer"] },
    isRequired: false,
  };
  const open: CustomFieldDefClient = {
    key: "note",
    label: "Note",
    fieldType: "text",
    config: {},
    isRequired: false,
  };
  const keys = (viewer?: Parameters<typeof customFieldColumns>[1]) =>
    customFieldColumns([restricted, open], viewer).map((column) => column.key);
  assert.deepEqual(
    keys(),
    ["cf_cost_basis", "cf_note"],
    "without a viewer every definition keeps its column",
  );
  assert.deepEqual(keys({ roleKeys: ["clerk"], canManageCustomFields: false }), ["cf_note"]);
  assert.deepEqual(keys({ roleKeys: ["buyer"], canManageCustomFields: false }), [
    "cf_cost_basis",
    "cf_note",
  ]);
  assert.deepEqual(keys({ roleKeys: [], canManageCustomFields: true }), [
    "cf_cost_basis",
    "cf_note",
  ]);
});
