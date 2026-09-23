import assert from "node:assert/strict";
import test from "node:test";
import { resolveOutboundPath } from "./delivery-path.ts";
import { PaymentError } from "../payments/payment-errors.ts";

test("a safe artifact name joins onto the configured folder verbatim", () => {
  assert.equal(resolveOutboundPath("outbound", "SEPA-42.xml"), "outbound/SEPA-42.xml");
});

test("a traversal artifact name never reaches the backend — refused at delivery", () => {
  // The exact attack from the defect: backend.cleanPath would normalize
  // outbound/../inbound/statement.ofx into the bank-feed folder.
  assert.throws(
    () => resolveOutboundPath("outbound", "../inbound/statement.ofx"),
    (e: unknown) => e instanceof PaymentError && /plain file name/.test((e as Error).message),
    "delivery must re-validate the stored name, not trust artifact creation",
  );
});

test("absolute, backslash, NUL and overlong names are refused at delivery", () => {
  for (const hostile of ["/inbound/x.ofx", "..\\inbound\\x.ofx", "x\0.ofx", `x${"y".repeat(300)}.ofx`]) {
    assert.throws(() => resolveOutboundPath("outbound", hostile), PaymentError, JSON.stringify(hostile.slice(0, 20)));
  }
});
