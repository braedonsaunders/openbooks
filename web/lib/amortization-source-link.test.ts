import assert from "node:assert/strict";
import test from "node:test";
import { amortizationSourceHref } from "./amortization-source-link";

test("amortization source links open their native records", () => {
  const id = "4d756422-48a4-4c1e-9ff0-9e6af8b2dc65";
  assert.equal(amortizationSourceHref("journal", id), `/journal?journalEntry=${id}`);
  assert.equal(amortizationSourceHref("vendor_bill", id), `/ap/bills?doc=${id}`);
  assert.equal(amortizationSourceHref("expense_report", id), `/expenses/reports?expense=${id}`);
  assert.equal(amortizationSourceHref("other", id), null);
  assert.equal(amortizationSourceHref("journal", null), null);
});
