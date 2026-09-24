import assert from "node:assert/strict";
import test from "node:test";
import { HrmDocumentsError } from "./errors.ts";
import { validateTemplateInput } from "./templates.ts";

const base = {
  name: "Employment letter",
  categoryKey: "employment-letter",
  bodyTemplate: "Hello {{employee_name}}",
  mergeFields: ["employee_name"],
  requiresSignature: false,
  signerRoles: [],
  acknowledgmentOnly: false,
};

test("template merge fields must come from the document merge resolver", () => {
  const valid = validateTemplateInput(base);
  assert.deepEqual(valid.mergeFields, ["employee_name"]);

  assert.throws(
    () => validateTemplateInput({ ...base, mergeFields: ["employee_name", "employee_tax_id"] }),
    (error: unknown) => error instanceof HrmDocumentsError &&
      error.code === "VALIDATION" && /employee_tax_id/.test(error.message),
  );
});
