import assert from "node:assert/strict";
import test from "node:test";
import { PaymentError } from "../payments-core/payment-errors.ts";
import {
  assertInvoiceWriteOffWithinOpenBalance,
  normalizeInvoiceWriteOffAmount,
  normalizeInvoiceWriteOffReason,
  resolveInvoiceWriteOffAccount,
  validateInvoiceWriteOffDate,
} from "./invoice-write-off.ts";

const ALLOWANCE = "11111111-1111-4111-8111-111111111111";
const BAD_DEBT = "22222222-2222-4222-8222-222222222222";

test("write-off debits the allowance when one is configured, otherwise bad debt expense", () => {
  assert.deepEqual(
    resolveInvoiceWriteOffAccount({
      allowanceForDoubtfulAccounts: ALLOWANCE,
      badDebtExpense: BAD_DEBT,
    }),
    { role: "allowanceForDoubtfulAccounts", accountId: ALLOWANCE },
  );
  assert.deepEqual(resolveInvoiceWriteOffAccount({ badDebtExpense: BAD_DEBT }), {
    role: "badDebtExpense",
    accountId: BAD_DEBT,
  });
});

test("write-off with neither control configured refuses and names the setting to change", () => {
  assert.throws(
    () => resolveInvoiceWriteOffAccount({}),
    (error: unknown) => {
      assert.ok(error instanceof PaymentError);
      assert.match(error.message, /Bad debt expense/);
      assert.match(error.message, /Allowance for doubtful accounts/);
      assert.match(error.message, /Control accounts/);
      return true;
    },
  );
});

test("write-off amount is an exact positive decimal with at most four places", () => {
  assert.equal(normalizeInvoiceWriteOffAmount("125"), "125.0000");
  assert.equal(normalizeInvoiceWriteOffAmount(" 125.5 "), "125.5000");
  assert.equal(normalizeInvoiceWriteOffAmount("0.01"), "0.0100");
  assert.equal(normalizeInvoiceWriteOffAmount("125.125"), "125.1250");
  assert.equal(normalizeInvoiceWriteOffAmount("125.1234"), "125.1234");
  for (const refused of ["", "0", "0.00", "-1.00", "1.12345", "1e3", "12,50", "abc", 125, null]) {
    assert.throws(
      () => normalizeInvoiceWriteOffAmount(refused),
      PaymentError,
      `expected refusal for ${String(refused)}`,
    );
  }
});

test("write-off cannot exceed the open balance; equal to the balance is allowed", () => {
  assert.doesNotThrow(() =>
    assertInvoiceWriteOffWithinOpenBalance("250.0000", "250.0000", "INV-1"),
  );
  assert.throws(
    () => assertInvoiceWriteOffWithinOpenBalance("250.0100", "250.0000", "INV-1"),
    (error: unknown) => {
      assert.ok(error instanceof PaymentError);
      assert.match(error.message, /250\.0000 or less/);
      return true;
    },
  );
});

test("write-off date must be a calendar date on or after the invoice date", () => {
  assert.equal(validateInvoiceWriteOffDate("2026-10-11", "INV-1", "2026-10-01"), "2026-10-11");
  assert.equal(validateInvoiceWriteOffDate("2026-10-01", "INV-1", "2026-10-01"), "2026-10-01");
  assert.throws(
    () => validateInvoiceWriteOffDate("2026-09-30", "INV-1", "2026-10-01"),
    PaymentError,
  );
  assert.throws(
    () => validateInvoiceWriteOffDate("2026-02-30", "INV-1", "2026-01-01"),
    PaymentError,
  );
  assert.throws(() => validateInvoiceWriteOffDate(undefined, "INV-1", "2026-01-01"), PaymentError);
});

test("write-off reason is required, trimmed and bounded", () => {
  assert.equal(normalizeInvoiceWriteOffReason("  Customer insolvent  "), "Customer insolvent");
  assert.throws(() => normalizeInvoiceWriteOffReason("   "), PaymentError);
  assert.throws(() => normalizeInvoiceWriteOffReason(undefined), PaymentError);
  assert.throws(() => normalizeInvoiceWriteOffReason("x".repeat(501)), PaymentError);
});
