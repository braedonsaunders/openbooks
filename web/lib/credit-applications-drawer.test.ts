import assert from "node:assert/strict";
import test from "node:test";
import { creditApplicationsDrawer } from "./credit-applications-drawer.ts";

const DOC = "22222222-2222-4222-8222-222222222222";
const PARTY = "11111111-1111-4111-8111-111111111111";
const both = { ar: true, ap: true };

test("a posted customer credit memo carries the AR panel with its customer", () => {
  assert.deepEqual(
    creditApplicationsDrawer(
      { id: DOC, kind: "customer_credit", status: "posted", party_id: PARTY },
      { ar: true, ap: false },
    ),
    { documentId: DOC, side: "ar", partyId: PARTY, canApply: true },
  );
});

test("a posted vendor credit carries the AP panel and gates Apply on ap.pay", () => {
  assert.deepEqual(
    creditApplicationsDrawer(
      { id: DOC, kind: "vendor_credit", status: "posted", party_id: PARTY },
      { ar: true, ap: false },
    ),
    { documentId: DOC, side: "ap", partyId: PARTY, canApply: false },
  );
});

test("a credit without a party still carries the panel, with no party to apply to", () => {
  assert.equal(
    creditApplicationsDrawer(
      { id: DOC, kind: "customer_credit", status: "posted", party_id: null },
      both,
    )?.partyId,
    null,
  );
});

test("a draft or reversed credit has nothing to settle and carries no panel", () => {
  for (const status of ["draft", "reversed"]) {
    assert.equal(
      creditApplicationsDrawer({ id: DOC, kind: "customer_credit", status, party_id: PARTY }, both),
      null,
      status,
    );
  }
});

test("invoices, bills and absent documents never carry the panel", () => {
  assert.equal(
    creditApplicationsDrawer(
      { id: DOC, kind: "customer_invoice", status: "posted", party_id: PARTY },
      both,
    ),
    null,
  );
  assert.equal(
    creditApplicationsDrawer(
      { id: DOC, kind: "vendor_bill", status: "posted", party_id: PARTY },
      both,
    ),
    null,
  );
  assert.equal(creditApplicationsDrawer(null, both), null);
  assert.equal(creditApplicationsDrawer(undefined, both), null);
});
