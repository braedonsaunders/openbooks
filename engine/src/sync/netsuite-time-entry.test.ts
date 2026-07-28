import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNetSuiteTimeEntry } from "./netsuite-source.ts";

test("NetSuite billed time remains billed without local invoice-line provenance", () => {
  const entry = normalizeNetSuiteTimeEntry({
    id: "113699",
    employee: "104901",
    customer: "133829",
    item: "128",
    hours: "2",
    rate: "130.73",
    isbillable: "T",
    billed: "T",
    billingstatus: "Billed",
    trandate: "06/22/2026",
  });

  assert.equal(entry.sourceRef, "113699");
  assert.equal(entry.fields.billingStatus, "billed");
  assert.equal(entry.fields.sourceBillingStatus, "Billed");
  assert.equal(entry.fields.isBillable, true);
});

test("NetSuite unbilled and non-billable time normalize deterministically", () => {
  const unbilled = normalizeNetSuiteTimeEntry({
    id: "1",
    isbillable: "T",
    billed: "F",
    billingstatus: "Unbilled",
  });
  const nonBillable = normalizeNetSuiteTimeEntry({
    id: "2",
    isbillable: "F",
    billed: "F",
  });

  assert.equal(unbilled.fields.billingStatus, "unbilled");
  assert.equal(nonBillable.fields.billingStatus, "unbilled");
  assert.equal(nonBillable.fields.isBillable, false);
});
