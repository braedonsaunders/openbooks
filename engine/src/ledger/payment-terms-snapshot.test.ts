import assert from "node:assert/strict";
import { test } from "node:test";
import { readDocumentPaymentTermsSnapshot } from "./payment-terms-snapshot.ts";

const subject = {
  kind: "vendor_bill",
  partyId: "10000000-0000-0000-0000-000000000001",
  documentDate: "2028-02-28",
};
const retained = {
  version: 1,
  mode: "discount",
  source: "vendor",
  documentKind: subject.kind,
  partyId: subject.partyId,
  documentDate: subject.documentDate,
  terms: {
    id: "10000000-0000-0000-0000-000000000002",
    name: "2/10 Net 30",
    netDays: 30,
    discountDays: 10,
    discountPercent: "2.0000",
    revisionHash: "a".repeat(64),
  },
};

test("retained payment authority refuses unknown subject identity and unrecorded policy", () => {
  assert.deepEqual(readDocumentPaymentTermsSnapshot(retained, subject), retained);
  for (const value of [
    null,
    {},
    { ...retained, partyId: "10000000-0000-0000-0000-000000000003" },
    { ...retained, documentDate: "2028-02-29" },
    { ...retained, version: 2 },
    { ...retained, source: "current_vendor" },
  ]) {
    assert.throws(
      () => readDocumentPaymentTermsSnapshot(value, subject),
      /missing or invalid retained payment terms/,
    );
  }
});

test("retained discount policy refuses numeric coercion, impossible dates and total-payment discounts", () => {
  for (const terms of [
    { ...retained.terms, discountPercent: 2 },
    { ...retained.terms, discountPercent: "100.0000" },
    { ...retained.terms, discountPercent: "2.00001" },
    { ...retained.terms, discountDays: -1 },
    { ...retained.terms, discountDays: 0.5 },
    { ...retained.terms, revisionHash: "missing" },
  ])
    assert.throws(() => readDocumentPaymentTermsSnapshot({ ...retained, terms }, subject));
  const finalDay = { ...subject, documentDate: "9999-12-31" };
  assert.throws(() =>
    readDocumentPaymentTermsSnapshot(
      { ...retained, documentDate: finalDay.documentDate },
      finalDay,
    ),
  );
  assert.throws(() =>
    readDocumentPaymentTermsSnapshot(
      { ...retained, documentDate: "2028-02-30" },
      { ...subject, documentDate: "2028-02-30" },
    ),
  );
});

test("explicit no-discount and inapplicable reimbursement policies remain distinct from missing evidence", () => {
  const none = { ...retained, mode: "no_discount", source: "none", terms: null };
  assert.deepEqual(readDocumentPaymentTermsSnapshot(none, subject), none);
  assert.throws(() => readDocumentPaymentTermsSnapshot({ ...none, mode: "discount" }, subject));
  const expense = { ...subject, kind: "expense_report" };
  const inapplicable = {
    ...none,
    documentKind: expense.kind,
    mode: "not_applicable",
    source: "not_applicable",
  };
  assert.deepEqual(readDocumentPaymentTermsSnapshot(inapplicable, expense), inapplicable);
  assert.throws(() => readDocumentPaymentTermsSnapshot(inapplicable, subject));
});
