import assert from "node:assert/strict";
import test from "node:test";
import { assertSafePaymentFilename, MAX_PAYMENT_FILENAME_BYTES } from "./payment-filenames.ts";
import { PaymentError } from "./payment-errors.ts";

test("built-in rail names and a realistic custom name pass through unchanged", () => {
  for (const name of ["SEPA-42.xml", "NACHA-42.ach", "CPA005-7.txt", "statement.ofx", "payments 2026-09-23.csv"]) {
    assert.equal(assertSafePaymentFilename(name), name);
  }
});

test("a traversal filename from a custom formatter is refused with the remedy", () => {
  assert.throws(
    () => assertSafePaymentFilename("../inbound/statement.ofx"),
    (e: unknown) =>
      e instanceof PaymentError &&
      /plain file name/.test(e.message) &&
      /path separator/.test(e.message),
    "the refusal must name the plain-file-name remedy, not just the violation",
  );
});

test("absolute paths, backslashes, NUL bytes and control characters are refused", () => {
  for (const hostile of ["/etc/passwd", "outbound\\payments.xml", "pay\0ment.xml", "pay\x01ment.xml", "pay\x7fment.xml"]) {
    assert.throws(() => assertSafePaymentFilename(hostile), PaymentError, JSON.stringify(hostile));
  }
});

test("dot segments, empty names and overlong names are refused", () => {
  for (const hostile of [".", "..", "", "a".repeat(MAX_PAYMENT_FILENAME_BYTES + 1)]) {
    assert.throws(() => assertSafePaymentFilename(hostile), PaymentError, JSON.stringify(hostile.slice(0, 20)));
  }
  // Exactly 255 bytes is still a legal name.
  assert.equal(assertSafePaymentFilename("a".repeat(MAX_PAYMENT_FILENAME_BYTES - 4) + ".xml"), "a".repeat(MAX_PAYMENT_FILENAME_BYTES - 4) + ".xml");
});

test("names the receiving filesystem would silently rewrite are refused", () => {
  for (const hostile of ["payments.", "payments "]) {
    assert.throws(() => assertSafePaymentFilename(hostile), PaymentError, JSON.stringify(hostile));
  }
});
