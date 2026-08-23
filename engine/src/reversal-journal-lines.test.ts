import assert from "node:assert/strict";
import test from "node:test";
import { reversalJournalLines } from "./reversal-journal-lines.ts";

const ENTRY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SUBSIDIARY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("reversalJournalLines negates amounts and quantity and preserves unit and custom", () => {
  const [reversal] = reversalJournalLines(
    [
      {
        lineNumber: 1,
        accountId: ACCOUNT_ID,
        subsidiaryId: SUBSIDIARY_ID,
        amount: "125.0000",
        currency: "CAD",
        txnAmount: "125.0000",
        fxRate: "1",
        partyId: null,
        departmentId: null,
        projectId: null,
        locationId: null,
        classId: null,
        equipmentUnitId: null,
        extraDims: {},
        paymentCardId: null,
        taxCodeId: null,
        memo: "source memo",
        quantity: "10.0000",
        unit: "hours",
        custom: { lot: "A" },
      },
    ],
    { entryId: ENTRY_ID, orgId: ORG_ID },
  );

  assert.deepEqual(reversal, {
    orgId: ORG_ID,
    entryId: ENTRY_ID,
    lineNumber: 1,
    accountId: ACCOUNT_ID,
    subsidiaryId: SUBSIDIARY_ID,
    amount: "-125.0000",
    currency: "CAD",
    txnAmount: "-125.0000",
    fxRate: "1",
    partyId: null,
    departmentId: null,
    projectId: null,
    locationId: null,
    classId: null,
    equipmentUnitId: null,
    extraDims: {},
    paymentCardId: null,
    taxCodeId: null,
    memo: "source memo",
    quantity: "-10.0000",
    unit: "hours",
    dueDate: null,
    isOpenItem: false,
    custom: { lot: "A" },
  });
});

test("reversalJournalLines keeps null quantity", () => {
  const [reversal] = reversalJournalLines(
    [
      {
        lineNumber: 1,
        accountId: ACCOUNT_ID,
        subsidiaryId: SUBSIDIARY_ID,
        amount: "50.0000",
        currency: "CAD",
        txnAmount: "50.0000",
        fxRate: "1",
        partyId: null,
        departmentId: null,
        projectId: null,
        locationId: null,
        classId: null,
        equipmentUnitId: null,
        extraDims: {},
        paymentCardId: null,
        taxCodeId: null,
        memo: null,
        quantity: null,
        unit: null,
        custom: {},
      },
    ],
    { entryId: ENTRY_ID, orgId: ORG_ID },
  );

  assert.equal(reversal.quantity, null);
  assert.equal(reversal.unit, null);
});
