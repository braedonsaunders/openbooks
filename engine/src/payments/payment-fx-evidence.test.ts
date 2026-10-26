import assert from "node:assert/strict";
import test from "node:test";
import { PaymentError } from "../payments-core/payment-errors.ts";
import {
  assertPaymentFxQuoteAgrees,
  paymentFxIdentity,
  paymentFxRateForSave,
  planPaymentFxEdit,
  storedPaymentFxEvidence,
  type DocumentFxRateEvidence,
} from "./payment-fx-evidence.ts";

const ENTITY = "6f1c2a52-5d7e-4f7a-9a51-2f4b8f0e9c11";
const OTHER_ENTITY = "0b8f8e1a-3c2d-4e5f-8a9b-1c2d3e4f5a6b";

const identity = paymentFxIdentity({
  currency: "EUR",
  functionalCurrency: "CAD",
  documentDate: "2026-07-15",
  subsidiaryId: ENTITY,
})!;
const request = {
  rate: "1.115",
  source: "Bank confirmation",
  reason: "Rate on the bank's receipt confirmation",
  fromCurrency: "EUR",
  toCurrency: "CAD",
  rateDate: "2026-07-15",
};
const evidence: DocumentFxRateEvidence = { version: 1, ...request, subsidiaryId: ENTITY };

test("a payment rate records evidence bound to the payment's own entity, pair and posting date", () => {
  assert.deepEqual(
    planPaymentFxEdit({ kind: "customer_payment", input: request, stored: null, identity }),
    { action: "set", evidence },
  );
  assert.deepEqual(
    planPaymentFxEdit({ kind: "vendor_payment", input: request, stored: null, identity }),
    { action: "set", evidence },
  );
});

test("the payment planner refuses other kinds, naming the payment kinds it allows", () => {
  for (const kind of ["customer_invoice", "vendor_bill", "customer_credit"]) {
    assert.throws(
      () => planPaymentFxEdit({ kind, input: request, stored: null, identity }),
      (error: unknown) =>
        error instanceof PaymentError &&
        /only on customer payments and vendor payments/.test(error.message),
    );
  }
});

test("a payment rate refuses a pair, date or entity it was not quoted for", () => {
  const refuse = (input: unknown, pattern: RegExp, at = identity) =>
    assert.throws(
      () => planPaymentFxEdit({ kind: "customer_payment", input, stored: null, identity: at }),
      (error: unknown) => error instanceof PaymentError && pattern.test(error.message),
    );
  refuse({ ...request, fromCurrency: "CAD", toCurrency: "EUR" }, /must convert EUR to CAD/);
  refuse(
    { ...request, rateDate: "2026-07-14" },
    /must be for 2026-07-15, the date this document posts on/,
  );
  refuse({ ...request, rate: "0" }, /positive exact decimal/);
  refuse({ ...request, source: " " }, /where the exchange rate came from/);
  refuse({ ...request, reason: "short" }, /8 to 500 characters/);
  refuse(
    request,
    /has no exchange rate to record/,
    paymentFxIdentity({
      currency: "CAD",
      functionalCurrency: "CAD",
      documentDate: "2026-07-15",
      subsidiaryId: ENTITY,
    })!,
  );
});

test("an omitted request keeps payment evidence only while its identity is unchanged", () => {
  assert.deepEqual(
    planPaymentFxEdit({ kind: "customer_payment", input: undefined, stored: evidence, identity }),
    { action: "keep" },
  );
  const changes: [Partial<typeof identity>, RegExp][] = [
    [{ rateDate: "2026-07-16" }, /previous posting date/],
    [{ currency: "USD" }, /previous currency/],
    [{ subsidiaryId: OTHER_ENTITY }, /previous legal entity/],
    [{ functionalCurrency: "USD" }, /previous legal entity/],
  ];
  for (const [change, pattern] of changes) {
    assert.throws(
      () =>
        planPaymentFxEdit({
          kind: "customer_payment",
          input: undefined,
          stored: evidence,
          identity: { ...identity, ...change },
        }),
      (error: unknown) => error instanceof PaymentError && pattern.test(error.message),
    );
  }
  assert.deepEqual(
    planPaymentFxEdit({ kind: "customer_payment", input: null, stored: evidence, identity }),
    { action: "clear" },
  );
  assert.deepEqual(
    planPaymentFxEdit({ kind: "customer_payment", input: null, stored: null, identity }),
    { action: "keep" },
  );
});

test("a pegged rate of exactly 1 is recordable evidence, not an unset rate", () => {
  assert.deepEqual(
    planPaymentFxEdit({
      kind: "vendor_payment",
      input: { ...request, rate: "1" },
      stored: null,
      identity,
    }),
    { action: "set", evidence: { ...evidence, rate: "1" } },
  );
});

test("stored payment evidence parses the native evidence value and refuses malformed values", () => {
  assert.deepEqual(storedPaymentFxEvidence(evidence), evidence);
  assert.equal(storedPaymentFxEvidence(null), null);
  assert.equal(storedPaymentFxEvidence(undefined), null);
  assert.throws(() => storedPaymentFxEvidence({ ...evidence, rate: "-1" }), PaymentError);
});

test("only an actual provider or processor contractual quote can conflict with recorded evidence", () => {
  assertPaymentFxQuoteAgrees({
    evidence,
    quoteRate: "1.1150000000",
    quoteLabel: "processor contractual",
  });
  assertPaymentFxQuoteAgrees({
    evidence: null,
    quoteRate: "1.2000000000",
    quoteLabel: "processor contractual",
  });
  assertPaymentFxQuoteAgrees({ evidence, quoteRate: null, quoteLabel: "processor contractual" });
  assert.throws(
    () =>
      assertPaymentFxQuoteAgrees({
        evidence,
        quoteRate: "1.2000000000",
        quoteLabel: "processor contractual",
      }),
    (error: unknown) =>
      error instanceof PaymentError &&
      /differs from the processor contractual rate 1\.2000000000/.test(error.message),
  );
});

test("the saved rate follows the plan: recorded rate stands, clearing falls back to the basis", () => {
  assert.equal(
    paymentFxRateForSave({
      plan: { action: "set", evidence },
      stored: null,
      basisRate: null,
      currentRate: "1",
    }),
    "1.115",
  );
  assert.equal(
    paymentFxRateForSave({
      plan: { action: "keep" },
      stored: evidence,
      basisRate: null,
      currentRate: "1",
    }),
    "1.115",
  );
  assert.equal(
    paymentFxRateForSave({
      plan: { action: "keep" },
      stored: null,
      basisRate: "1.2",
      currentRate: "1",
    }),
    "1.2",
  );
  assert.equal(
    paymentFxRateForSave({
      plan: { action: "keep" },
      stored: null,
      basisRate: null,
      currentRate: "1.05",
    }),
    "1.05",
  );
  assert.equal(
    paymentFxRateForSave({
      plan: { action: "clear" },
      stored: evidence,
      basisRate: null,
      currentRate: "1.115",
    }),
    "1",
  );
});
