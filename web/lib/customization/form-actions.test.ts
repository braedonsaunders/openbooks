import assert from "node:assert/strict";
import test from "node:test";
import { FORM_ACTION_KEYS } from "@openbooks/customization";
import { supportedFormActionsFor } from "./form-actions";

test("record types without an entry are offered the full action vocabulary", () => {
  assert.deepEqual([...supportedFormActionsFor("vendor_bill")], [...FORM_ACTION_KEYS]);
  assert.deepEqual([...supportedFormActionsFor("something_new")], [...FORM_ACTION_KEYS]);
});

test("field_ticket is offered only the actions its drawer implements", () => {
  // The field-ticket drawer's renderFormAction handles customize, pdf,
  // workflow, approval, submit (and edit as the primary action) — post, void,
  // gl_impact and delete render nothing, so offering their toggles is dead.
  assert.deepEqual([...supportedFormActionsFor("field_ticket")], [
    "customize",
    "pdf",
    "workflow",
    "approval",
    "edit",
    "submit",
  ]);
});
