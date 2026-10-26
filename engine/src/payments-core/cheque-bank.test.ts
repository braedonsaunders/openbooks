import assert from "node:assert/strict";
import test from "node:test";
import { chequeMicrFields, validateChequeBank } from "./cheque-bank.ts";

const specification = {
  bankName: "Sample Bank",
  branchAddress: "1 Sample Street",
  institution: "003",
  transit: "01234",
  accountEncoding: "0012-345 678",
  effectiveFrom: "2026-01-01",
};
test("Canadian cheque encoding retains bank-specified zeros and account separators", () => {
  const bank = validateChequeBank(specification);
  assert.deepEqual(chequeMicrFields("000042", bank), {
    micrSerial: "⑈000042⑈",
    micrTransit: "⑆01234⑉003⑆",
    micrAccount: "⑈0012⑉345 678",
  });
  assert.throws(() => chequeMicrFields("CHQ-000042", bank), /numeric/);
  assert.throws(() => chequeMicrFields("123456789012", bank), /eleven/);
});
test("Canadian cheque configuration refuses absent bank facts and invalid dates without routing coercion", () => {
  for (const patch of [
    { institution: "3" },
    { transit: "1234" },
    { accountEncoding: "12/345" },
    { accountEncoding: "" },
    { effectiveFrom: "2026-02-30" },
    { bankName: "" },
  ])
    assert.throws(() => validateChequeBank({ ...specification, ...patch }));
});
