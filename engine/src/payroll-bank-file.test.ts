import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPayRunBankFile,
  PAYROLL_BANK_FILE_EXPORT_DISABLED_MESSAGE,
  PAYROLL_BANK_FILE_EXPORT_ENABLED,
} from "./payroll-bank-file.ts";

test("payroll bank-file export fails closed until audited immutable artifacts exist", async () => {
  assert.equal(PAYROLL_BANK_FILE_EXPORT_ENABLED, false);
  await assert.rejects(
    buildPayRunBankFile({ orgId: "org", documentId: "run" }),
    new RegExp(PAYROLL_BANK_FILE_EXPORT_DISABLED_MESSAGE),
  );
});
