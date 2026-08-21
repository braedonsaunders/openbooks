import assert from "node:assert/strict";
import test from "node:test";
import { headerValues, RESERVED_DOCUMENT_FIELD_KEYS } from "./documents-adapter.ts";
import { WRITABLE_DOCUMENT_FIELDS } from "./subject-profiles.ts";

/**
 * headerValues precedence + the reserved-key set derived from it: together
 * they close the shadowing hole where record-typed custom jsonb data could
 * override a real header field (`total`, `status`, …) in flow condition
 * evaluation and {{token}} interpolation.
 */

function docRow(custom: Record<string, unknown>): Parameters<typeof headerValues>[0] {
  return {
    custom,
    id: "11111111-1111-4111-8111-111111111111",
    kind: "vendor_bill",
    documentNumber: "BILL-0007",
    status: "pending_approval",
    partyId: "22222222-2222-4222-8222-222222222222",
    documentDate: "2026-08-01",
    postingDate: null,
    dueDate: "2026-09-01",
    expectedPayDate: null,
    currency: "USD",
    fxRate: "1",
    subtotal: "90.00",
    taxTotal: "10.00",
    total: "100.00",
    openBalance: "100.00",
    memo: "real memo",
    internalNotes: null,
    referenceNumber: null,
    paymentHoldReason: null,
    billingMethod: null,
    isFinalInvoice: false,
    departmentId: null,
    projectId: null,
    locationId: null,
    classId: null,
    createdBy: "33333333-3333-4333-8333-333333333333",
  } as unknown as Parameters<typeof headerValues>[0];
}

test("built-in header values always win over same-named custom data", () => {
  const values = headerValues(
    docRow({
      total: "999999.99",
      status: "posted",
      memo: "attacker memo",
      kind: "journal",
      currency: "XXX",
      dueDate: "1999-01-01",
    }),
    "Acme Supplies",
  );
  assert.equal(values.total, "100.00");
  assert.equal(values.status, "pending_approval");
  assert.equal(values.memo, "real memo");
  assert.equal(values.kind, "vendor_bill");
  assert.equal(values.currency, "USD");
  assert.equal(values.dueDate, "2026-09-01");
});

test("non-colliding custom keys still ride along for conditions and interpolation", () => {
  const values = headerValues(
    docRow({ warranty_expires: "2027-01-31", site_code: "LDN-4" }),
    "Acme Supplies",
  );
  assert.equal(values.warranty_expires, "2027-01-31");
  assert.equal(values.site_code, "LDN-4");
});

test("reserved custom-field keys cover every exposed header key exactly", () => {
  // Every key headerValues can emit is protected…
  for (const key of Object.keys(headerValues(docRow({}), null))) {
    assert.equal(RESERVED_DOCUMENT_FIELD_KEYS.has(key), true, key);
  }
  // …every flow-writable column is protected…
  for (const key of WRITABLE_DOCUMENT_FIELDS) {
    assert.equal(RESERVED_DOCUMENT_FIELD_KEYS.has(key), true, key);
  }
  // …and the set is exactly that union — nothing reserved by accident.
  assert.equal(
    RESERVED_DOCUMENT_FIELD_KEYS.size,
    new Set([
      ...Object.keys(headerValues(docRow({}), null)),
      ...WRITABLE_DOCUMENT_FIELDS,
    ]).size,
  );
});

test("the shadowing vectors called out in review are all rejected keys", () => {
  for (const key of ["id", "kind", "status", "memo", "currency", "dueDate", "total"]) {
    assert.equal(RESERVED_DOCUMENT_FIELD_KEYS.has(key), true, key);
  }
});
