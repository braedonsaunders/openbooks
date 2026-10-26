import assert from "node:assert/strict";
import test from "node:test";
import { formatObjectCounts, shouldOpenImportWizard } from "./presentation";

test("billing history counts use translated labels and omit zero object counts", () => {
  const labels = new Map([
    ["count_customers", "Customers"],
    ["count_invoices", "Invoices"],
  ]);
  const formatted = formatObjectCounts(
    {
      customers: 2,
      plans: 0,
      subscriptions: 0,
      invoices: 5,
      creditNotes: 0,
      payments: 0,
      usage: 0,
      coupons: 0,
      revenueSchedules: 0,
    },
    (key) => labels.get(key) ?? key,
  );

  assert.equal(formatted, "Customers 2 · Invoices 5");
});

test("billing history count summary stays empty when the source has no counts", () => {
  assert.equal(
    formatObjectCounts(null, (key) => key),
    "—",
  );
  assert.equal(
    formatObjectCounts(
      {
        customers: 0,
        plans: 0,
        subscriptions: 0,
        invoices: 0,
        creditNotes: 0,
        payments: 0,
        usage: 0,
        coupons: 0,
        revenueSchedules: 0,
      },
      (key) => key,
    ),
    "—",
  );
});

test("the import wizard opens only for its explicit URL state", () => {
  assert.equal(shouldOpenImportWizard(new URLSearchParams("import=new")), true);
  assert.equal(shouldOpenImportWizard(new URLSearchParams("import=other")), false);
  assert.equal(shouldOpenImportWizard(new URLSearchParams()), false);
});
