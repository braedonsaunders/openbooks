import assert from "node:assert/strict";
import test from "node:test";
import { filterVisibleCustomFields, redactRecordCustomValues } from "./custom-field-read";

const definitions = [
  { key: "cost_basis", config: { allowedRoles: ["buyer"] } },
  { key: "memo", config: {} },
];

test("restricted custom values and query fields are hidden from roles outside their audience", () => {
  const viewer = { roleKeys: ["clerk"], canManageCustomFields: false };
  const row = { id: "row-1", custom: { cost_basis: "internal", memo: "public" } };
  assert.deepEqual(redactRecordCustomValues(row, definitions, viewer), {
    id: "row-1",
    custom: { memo: "public" },
  });
  assert.deepEqual(
    filterVisibleCustomFields(
      [
        { name: "cf_cost_basis", custom: true },
        { name: "cf_memo", custom: true },
        { name: "status", custom: false },
      ],
      definitions,
      viewer,
    ).map(({ name }) => name),
    ["cf_memo", "status"],
  );
});

test("authorized roles and custom-field managers retain restricted custom fields", () => {
  const fields = [{ name: "cf_cost_basis", custom: true }];
  assert.equal(
    filterVisibleCustomFields(fields, definitions, {
      roleKeys: ["buyer"],
      canManageCustomFields: false,
    }).length,
    1,
  );
  assert.equal(
    filterVisibleCustomFields(fields, definitions, {
      roleKeys: ["clerk"],
      canManageCustomFields: true,
    }).length,
    1,
  );
});
