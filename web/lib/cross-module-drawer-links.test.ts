import assert from "node:assert/strict";
import test from "node:test";
import {
  journalEntryDrawerHref,
  listRecordDrawerHref,
  paymentDrawerHref,
} from "./cross-module-drawer-links";

test("cross-module links use the destination record drawer query contract", () => {
  const id = "4d756422-48a4-4c1e-9ff0-9e6af8b2dc65";
  assert.equal(listRecordDrawerHref("customer_invoice", id), `/ar/invoices?doc=${id}`);
  assert.equal(paymentDrawerHref(id), `/payments?payment=${id}`);
  assert.equal(journalEntryDrawerHref(id), `/journal?journalEntry=${id}`);
  assert.equal(listRecordDrawerHref("expense_report", id), `/expenses/reports?expense=${id}`);
});
