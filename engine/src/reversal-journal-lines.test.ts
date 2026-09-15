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
  const reversal = reversalJournalLines(
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
  )[0]!;

  assert.equal(reversal.quantity, null);
  assert.equal(reversal.unit, null);
});

test("reversalJournalLines mirrors every signed field on a mixed-sign entry", () => {
  // A dropped negation on any one field leaves the reversal unbalanced
  // against its source: each source+reversal pair must sum to exactly zero.
  const sources = [
    {
      lineNumber: 1,
      accountId: ACCOUNT_ID,
      subsidiaryId: SUBSIDIARY_ID,
      amount: "125.0000",
      currency: "CAD",
      txnAmount: "100.0000",
      fxRate: "1.2500000000",
      partyId: "party-1",
      departmentId: "dept-1",
      projectId: "proj-1",
      locationId: "loc-1",
      classId: "class-1",
      equipmentUnitId: "unit-1",
      extraDims: { region: "west" },
      paymentCardId: null,
      taxCodeId: "tax-1",
      memo: "debit leg",
      quantity: "10.0000",
      unit: "hours",
      custom: { lot: "A" },
    },
    {
      lineNumber: 2,
      accountId: ACCOUNT_ID,
      subsidiaryId: SUBSIDIARY_ID,
      amount: "-125.0000",
      currency: "CAD",
      txnAmount: "-100.0000",
      fxRate: "1.2500000000",
      partyId: "party-1",
      departmentId: null,
      projectId: null,
      locationId: null,
      classId: null,
      equipmentUnitId: null,
      extraDims: {},
      paymentCardId: "card-1",
      taxCodeId: null,
      memo: null,
      quantity: "-2.5000",
      unit: "hours",
      custom: {},
    },
    {
      lineNumber: 3,
      accountId: ACCOUNT_ID,
      subsidiaryId: SUBSIDIARY_ID,
      amount: "0.0000",
      currency: "CAD",
      txnAmount: "0.0000",
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
      memo: "zero leg",
      quantity: null,
      unit: null,
      custom: {},
    },
  ];
  const reversed = reversalJournalLines(sources, { entryId: ENTRY_ID, orgId: ORG_ID });
  assert.equal(reversed.length, 3);
  assert.deepEqual(reversed.map((line) => [line.lineNumber, line.amount, line.txnAmount, line.quantity]), [
    [1, "-125.0000", "-100.0000", "-10.0000"],
    [2, "125.0000", "100.0000", "2.5000"],
    [3, "0.0000", "0.0000", null],
  ]);
});

test("reversal source pairs net to zero in ledger units", async () => {
  const { add } = await import("./money.ts");
  const sources = [
    {
      lineNumber: 1,
      accountId: ACCOUNT_ID,
      subsidiaryId: SUBSIDIARY_ID,
      amount: "125.0000",
      currency: "CAD",
      txnAmount: "100.0000",
      fxRate: "1.2500000000",
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
      quantity: "10.0000",
      unit: "hours",
      custom: {},
    },
    {
      lineNumber: 2,
      accountId: ACCOUNT_ID,
      subsidiaryId: SUBSIDIARY_ID,
      amount: "-125.0000",
      currency: "CAD",
      txnAmount: "-100.0000",
      fxRate: "1.2500000000",
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
      quantity: "-10.0000",
      unit: "hours",
      custom: {},
    },
  ];
  const reversed = reversalJournalLines(sources, { entryId: ENTRY_ID, orgId: ORG_ID });
  for (const [index, source] of sources.entries()) {
    const line = reversed[index]!;
    assert.equal(add(source.amount, line.amount), "0.0000", `amount nets to zero (line ${source.lineNumber})`);
    assert.equal(add(source.txnAmount, line.txnAmount), "0.0000", `txnAmount nets to zero (line ${source.lineNumber})`);
  }
  // Reversing the reversal restores the original signed amounts exactly.
  const restored = reversalJournalLines(
    reversed.map((line) => ({
      lineNumber: line.lineNumber!,
      accountId: line.accountId!,
      subsidiaryId: line.subsidiaryId!,
      amount: line.amount!,
      currency: line.currency!,
      txnAmount: line.txnAmount!,
      fxRate: line.fxRate!,
      partyId: line.partyId ?? null,
      departmentId: line.departmentId ?? null,
      projectId: line.projectId ?? null,
      locationId: line.locationId ?? null,
      classId: line.classId ?? null,
      equipmentUnitId: line.equipmentUnitId ?? null,
      extraDims: line.extraDims ?? {},
      paymentCardId: line.paymentCardId ?? null,
      taxCodeId: line.taxCodeId ?? null,
      memo: line.memo ?? null,
      quantity: line.quantity ?? null,
      unit: line.unit ?? null,
      custom: line.custom ?? {},
    })),
    { entryId: ENTRY_ID, orgId: ORG_ID },
  );
  assert.deepEqual(restored.map((line) => [line.amount, line.txnAmount, line.quantity]), [
    ["125.0000", "100.0000", "10.0000"],
    ["-125.0000", "-100.0000", "-10.0000"],
  ]);
});

test("reversalJournalLines preserves identity and analytical context, never open-item state", () => {
  const [line] = reversalJournalLines(
    [
      {
        lineNumber: 7,
        accountId: ACCOUNT_ID,
        subsidiaryId: SUBSIDIARY_ID,
        amount: "60.0000",
        currency: "USD",
        txnAmount: "60.0000",
        fxRate: "1.3512345678",
        partyId: "party-9",
        departmentId: "dept-9",
        projectId: "proj-9",
        locationId: "loc-9",
        classId: "class-9",
        equipmentUnitId: "unit-9",
        extraDims: { channel: "web" },
        paymentCardId: "card-9",
        taxCodeId: "tax-9",
        memo: "keep me",
        quantity: "3.0000",
        unit: "each",
        custom: { batch: 2 },
      },
    ],
    { entryId: ENTRY_ID, orgId: ORG_ID },
  )!;
  assert.equal(line!.orgId, ORG_ID);
  assert.equal(line!.entryId, ENTRY_ID);
  assert.equal(line!.lineNumber, 7);
  assert.equal(line!.accountId, ACCOUNT_ID);
  assert.equal(line!.subsidiaryId, SUBSIDIARY_ID);
  assert.equal(line!.currency, "USD");
  assert.equal(line!.fxRate, "1.3512345678");
  assert.equal(line!.partyId, "party-9");
  assert.equal(line!.departmentId, "dept-9");
  assert.equal(line!.projectId, "proj-9");
  assert.equal(line!.locationId, "loc-9");
  assert.equal(line!.classId, "class-9");
  assert.equal(line!.equipmentUnitId, "unit-9");
  assert.deepEqual(line!.extraDims, { channel: "web" });
  assert.equal(line!.paymentCardId, "card-9");
  assert.equal(line!.taxCodeId, "tax-9");
  assert.equal(line!.memo, "keep me");
  assert.equal(line!.unit, "each");
  assert.deepEqual(line!.custom, { batch: 2 });
  // A reversal must never inherit settlement state: it is a fresh mirror.
  assert.equal(line!.isOpenItem, false);
  assert.equal(line!.dueDate, null);
});
