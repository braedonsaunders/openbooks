import assert from "node:assert/strict";
import test from "node:test";
import {
  DocumentFxError,
  documentFxPostingRefusal,
  explicitFxRate,
  planDocumentFxEdit,
  readDocumentFxRateEvidence,
  type DocumentFxIdentity,
  type DocumentFxRateEvidence,
} from "./document-fx.ts";

const ENTITY = "6f1c2a52-5d7e-4f7a-9a51-2f4b8f0e9c11";
const OTHER_ENTITY = "0b8f8e1a-3c2d-4e5f-8a9b-1c2d3e4f5a6b";

const identity: DocumentFxIdentity = {
  currency: "USD",
  functionalCurrency: "CAD",
  rateDate: "2026-09-15",
  subsidiaryId: ENTITY,
};
const request = {
  rate: "1.3525",
  source: "Bank confirmation",
  reason: "Contracted conversion for this shipment",
  fromCurrency: "USD",
  toCurrency: "CAD",
  rateDate: "2026-09-15",
};
const evidence: DocumentFxRateEvidence = { version: 1, ...request, subsidiaryId: ENTITY };

test("an explicit rate is a positive exact decimal that fits the stored rate", () => {
  assert.equal(explicitFxRate("1.3525"), "1.3525");
  assert.equal(explicitFxRate("123456789.0123456789"), "123456789.0123456789");
  for (const refused of ["0", "-1.2", "1234567890", "1.12345678901", "1e3", "", " ", 1.35, null]) {
    assert.equal(explicitFxRate(refused), null, `${String(refused)} is refused`);
  }
});

test("a request records evidence bound to the document's own entity, currencies and posting date", () => {
  assert.deepEqual(
    planDocumentFxEdit({ kind: "vendor_bill", input: request, stored: null, identity }),
    { action: "set", evidence },
  );
  assert.deepEqual(
    planDocumentFxEdit({
      kind: "customer_invoice",
      input: { ...request, source: "  Bank confirmation  " },
      stored: null,
      identity,
    }),
    { action: "set", evidence },
    "authored text is stored trimmed",
  );
});

test("a request refuses a conversion, date, kind or entity it was not quoted for", () => {
  const refuse = (
    input: unknown,
    pattern: RegExp,
    kind = "vendor_bill",
    at: DocumentFxIdentity | null = identity,
  ) =>
    assert.throws(
      () => planDocumentFxEdit({ kind, input, stored: null, identity: at }),
      (error: unknown) => error instanceof DocumentFxError && pattern.test(error.message),
    );
  refuse({ ...request, toCurrency: "USD", fromCurrency: "CAD" }, /must convert USD to CAD/);
  refuse(
    { ...request, rateDate: "2026-09-14" },
    /must be for 2026-09-15, the date this document posts on/,
  );
  refuse({ ...request, rate: "0" }, /positive exact decimal/);
  refuse({ ...request, source: " " }, /where the exchange rate came from/);
  refuse({ ...request, reason: "short" }, /8 to 500 characters/);
  refuse(
    request,
    /only on customer invoices, vendor bills, customer credits and vendor credits/,
    "cash_sale",
  );
  refuse(request, /assign the document an active subsidiary/, "vendor_bill", null);
  refuse(
    request,
    /functional currency of its legal entity, so it has no exchange rate/,
    "vendor_bill",
    { ...identity, currency: "CAD" },
  );
});

test("an omitted request keeps evidence only while the document keeps the identity it was recorded for", () => {
  assert.deepEqual(
    planDocumentFxEdit({ kind: "vendor_bill", input: undefined, stored: evidence, identity }),
    { action: "keep" },
  );
  assert.deepEqual(
    planDocumentFxEdit({ kind: "vendor_bill", input: undefined, stored: null, identity: null }),
    { action: "keep" },
  );
  const changes: [Partial<DocumentFxIdentity>, RegExp][] = [
    [{ rateDate: "2026-09-16" }, /previous posting date; record a rate for the new posting date/],
    [{ currency: "EUR" }, /previous currency/],
    [{ subsidiaryId: OTHER_ENTITY }, /previous legal entity/],
    [{ functionalCurrency: "USD" }, /previous legal entity/],
  ];
  for (const [change, pattern] of changes) {
    assert.throws(
      () =>
        planDocumentFxEdit({
          kind: "vendor_bill",
          input: undefined,
          stored: evidence,
          identity: { ...identity, ...change },
        }),
      (error: unknown) => error instanceof DocumentFxError && pattern.test(error.message),
    );
  }
  // A replacement recorded with the change binds the new identity.
  const moved = { ...identity, rateDate: "2026-09-16" };
  assert.deepEqual(
    planDocumentFxEdit({
      kind: "vendor_bill",
      input: { ...request, rateDate: "2026-09-16" },
      stored: evidence,
      identity: moved,
    }),
    { action: "set", evidence: { ...evidence, rateDate: "2026-09-16" } },
  );
});

test("clearing removes recorded evidence and leaves a document without any untouched", () => {
  assert.deepEqual(
    planDocumentFxEdit({
      kind: "vendor_bill",
      input: null,
      stored: evidence,
      identity: { ...identity, rateDate: "2026-09-30" },
    }),
    { action: "clear" },
  );
  assert.deepEqual(
    planDocumentFxEdit({ kind: "vendor_bill", input: null, stored: null, identity }),
    { action: "keep" },
  );
});

test("stored evidence must have exactly the recorded shape", () => {
  assert.deepEqual(readDocumentFxRateEvidence(evidence), evidence);
  assert.equal(readDocumentFxRateEvidence(null), null);
  for (const malformed of [
    { ...evidence, version: 2 },
    { ...evidence, rate: "-1" },
    { ...evidence, extra: true },
    { ...evidence, rateDate: "2026-02-30" },
    { ...evidence, subsidiaryId: "root" },
    { ...evidence, toCurrency: "USD" },
    [evidence],
  ]) {
    assert.throws(() => readDocumentFxRateEvidence(malformed), DocumentFxError);
  }
});

test("posting refuses evidence that no longer describes the posting or the stored rate", () => {
  assert.equal(documentFxPostingRefusal("vendor_bill", evidence, identity, "1.3525000000"), null);
  assert.match(
    documentFxPostingRefusal(
      "vendor_bill",
      evidence,
      { ...identity, rateDate: "2026-10-01" },
      "1.3525",
    )!,
    /no longer matches this document's posting date; return it to draft/,
  );
  assert.match(
    documentFxPostingRefusal(
      "vendor_bill",
      evidence,
      { ...identity, functionalCurrency: "EUR" },
      "1.3525",
    )!,
    /legal entity/,
  );
  assert.match(
    documentFxPostingRefusal("vendor_bill", evidence, identity, "1.36")!,
    /differs from its recorded rate evidence/,
  );
  assert.match(
    documentFxPostingRefusal("cash_sale", evidence, identity, "1.3525")!,
    /only on customer invoices, vendor bills, customer credits, vendor credits/,
  );
  assert.equal(
    documentFxPostingRefusal("customer_credit", evidence, identity, "1.3525000000"),
    null,
    "a credit memo may post at its recorded rate",
  );
});
