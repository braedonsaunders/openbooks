import assert from "node:assert/strict";
import test from "node:test";
import { hiddenCustomFieldRefusal, type CustomFieldDef } from "./custom-fields.ts";
import type { CustomFieldViewer } from "@openbooks/customization";

const clerk: CustomFieldViewer = { roleKeys: ["clerk"], canManageCustomFields: false };
const manager: CustomFieldViewer = { roleKeys: ["clerk"], canManageCustomFields: true };

function def(
  key: string,
  config: Record<string, unknown> = {},
  isRequired = false,
): CustomFieldDef {
  return {
    id: `id-${key}`,
    targetTable: "items",
    targetKind: null,
    key,
    label: key.replace(/_/g, " "),
    fieldType: "text",
    config: config as CustomFieldDef["config"],
    isRequired,
    sortOrder: 0,
  };
}

const open = def("open_note");
const restricted = def("cost_basis", { allowedRoles: ["buyer"] });
const required = def("approval_code", { allowedRoles: ["buyer"] }, true);

test("an unchanged echo of a hidden value is accepted on update", () => {
  const refusal = hiddenCustomFieldRefusal(
    [open, restricted],
    clerk,
    { cost_basis: "100" },
    { cost_basis: "100" },
  );
  assert.equal(refusal, null);
});

test("an update that omits a hidden field is accepted and changes nothing", () => {
  assert.equal(
    hiddenCustomFieldRefusal([open, restricted], clerk, { open_note: "x" }, { cost_basis: "100" }),
    null,
  );
});

test("a changed hidden value is refused by name on update", () => {
  const refusal = hiddenCustomFieldRefusal(
    [open, restricted],
    clerk,
    { cost_basis: "120" },
    { cost_basis: "100" },
  );
  assert.ok(refusal);
  assert.equal(refusal.key, "cost_basis");
  assert.match(refusal.message, /restricted to other roles and cannot be changed by your role/);
});

test("clearing a stored hidden value is refused on update", () => {
  const refusal = hiddenCustomFieldRefusal(
    [restricted],
    clerk,
    { cost_basis: null },
    { cost_basis: "100" },
  );
  assert.equal(refusal?.key, "cost_basis");
});

test("an invalid hidden value is refused even when nothing is stored", () => {
  const numeric = def("margin_rate", { allowedRoles: ["buyer"] });
  numeric.fieldType = "number";
  const refusal = hiddenCustomFieldRefusal([numeric], clerk, { margin_rate: "not-a-number" }, {});
  assert.equal(refusal?.key, "margin_rate");
});

test("a create that sets a hidden value is refused", () => {
  const refusal = hiddenCustomFieldRefusal([open, restricted], clerk, { cost_basis: "100" }, null);
  assert.ok(refusal);
  assert.equal(refusal.key, "cost_basis");
  assert.match(refusal.message, /cannot be set by your role/);
});

test("a create that omits an optional hidden field is accepted", () => {
  assert.equal(hiddenCustomFieldRefusal([open, restricted], clerk, { open_note: "x" }, null), null);
});

test("a create without a required hidden field is refused, since no permitted role can satisfy it here", () => {
  const refusal = hiddenCustomFieldRefusal([required], clerk, {}, null);
  assert.ok(refusal);
  assert.equal(refusal.key, "approval_code");
  assert.match(refusal.message, /is required and restricted to other roles/);
});

test("managers pass every write check", () => {
  assert.equal(
    hiddenCustomFieldRefusal(
      [restricted, required],
      manager,
      { cost_basis: "1", approval_code: "A" },
      null,
    ),
    null,
  );
  assert.equal(
    hiddenCustomFieldRefusal([restricted], manager, { cost_basis: "2" }, { cost_basis: "1" }),
    null,
  );
});
