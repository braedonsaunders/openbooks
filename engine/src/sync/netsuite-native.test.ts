import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNativeFromNetSuite,
  type NsHeader,
  type NsLine,
} from "./netsuite-native.ts";
import {
  NETSUITE_TRANSACTION_WATERMARK_QUERY,
  netSuiteCreditOpenBalance,
  numericIdWindows,
  parseNetSuiteMappings,
  uniqueNetSuiteApplicationLinks,
  uniqueNetSuiteTransactionLines,
} from "./netsuite-source.ts";
import type { NativeContext } from "./native.ts";

const context = {
  accountByRef: new Map([
    [
      "10",
      { id: "account-a", number: "1000", name: "Cash", type: "asset_bank" },
    ],
    [
      "20",
      { id: "account-b", number: "6000", name: "Expense", type: "expense" },
    ],
  ]),
  subsidiaryByRef: new Map([
    ["1", "sub-root"],
    ["2", "sub-child"],
  ]),
  partyByRef: new Map(),
  deptByRef: new Map(),
  projectByRef: new Map(),
  taxByRate: new Map(),
  taxCodeByRef: new Map(),
} as unknown as NativeContext;

const header: NsHeader = {
  id: "123",
  ttype: "Journal",
  trandate: "07/15/2026",
  posting: "T",
};

test("NetSuite journals retain header and line subsidiary identity", () => {
  const lines: NsLine[] = [
    {
      transaction: "123",
      id: "1",
      mainline: "T",
      taxline: "F",
      account: "10",
      netamount: "-100",
      subsidiary: "1",
    },
    {
      transaction: "123",
      id: "2",
      mainline: "F",
      taxline: "F",
      account: "20",
      netamount: "100",
      subsidiary: "2",
    },
  ];
  const built = buildNativeFromNetSuite(context, header, lines);
  assert.ok(!("skip" in built));
  assert.equal(built.doc.posting, true);
  assert.equal(built.doc.subsidiaryId, "sub-root");
  assert.deepEqual(
    built.doc.lines.map((line) => line.subsidiaryId),
    ["sub-root", "sub-child"],
  );
});

test("zero-value NetSuite journals remain source documents without an invented GL entry", () => {
  const lines: NsLine[] = [
    {
      transaction: "123",
      id: "1",
      mainline: "T",
      taxline: "F",
      account: "10",
      netamount: "0",
      subsidiary: "1",
    },
    {
      transaction: "123",
      id: "2",
      mainline: "T",
      taxline: "F",
      account: "20",
      netamount: "0",
      subsidiary: "1",
    },
  ];
  const built = buildNativeFromNetSuite(context, header, lines);
  assert.ok(!("skip" in built));
  assert.equal(built.doc.posting, false);
  assert.equal(built.doc.lines.length, 2);
  assert.ok(built.doc.lines.every((line) => line.amount === "0.0000"));
});

test("posting-flagged source transactions with no accounting impact are classified explicitly", () => {
  const zero = buildNativeFromNetSuite(
    context,
    { ...header, ttype: "ItemShip", posting: "T" },
    [
      {
        transaction: "123",
        id: "1",
        mainline: "T",
        taxline: "F",
        account: null,
        expenseaccount: null,
        netamount: null,
        foreignamount: null,
      },
    ],
  );
  assert.deepEqual(zero, { skip: "non-ledger source transaction ItemShip" });

  const financial = buildNativeFromNetSuite(
    context,
    { ...header, ttype: "ItemShip", posting: "T" },
    [
      {
        transaction: "123",
        id: "1",
        mainline: "T",
        taxline: "F",
        account: "10",
        netamount: "1",
        foreignamount: "1",
      },
    ],
  );
  assert.deepEqual(financial, {
    skip: "unsupported posting type ItemShip has ledger impact",
  });
});

test("NetSuite transactions fail closed when a subsidiary was not loaded", () => {
  const lines: NsLine[] = [
    {
      transaction: "123",
      id: "1",
      mainline: "T",
      taxline: "F",
      account: "10",
      netamount: "0",
      subsidiary: "99",
    },
  ];
  const built = buildNativeFromNetSuite(context, header, lines);
  assert.deepEqual(built, { skip: "unmapped subsidiary 99" });
});

test("NetSuite sales orders normalize source credit-side detail into document direction", () => {
  const built = buildNativeFromNetSuite(
    context,
    { ...header, ttype: "SalesOrd", posting: "F" },
    [
      {
        transaction: "123",
        id: "1",
        mainline: "F",
        taxline: "F",
        account: "20",
        netamount: "-100",
        subsidiary: "1",
      },
      {
        transaction: "123",
        id: "2",
        mainline: "F",
        taxline: "F",
        account: "20",
        netamount: "5",
        subsidiary: "1",
      },
    ],
  );
  assert.ok(!("skip" in built));
  assert.equal(built.doc.kind, "sales_order");
  assert.deepEqual(
    built.doc.lines.map((line) => line.amount),
    ["100.0000", "-5.0000"],
  );
});

test("NetSuite zero-rate lines do not invent an ambiguous tax-code identity", () => {
  const taxContext = {
    ...context,
    control: { ar: "account-a", ap: "account-a", bank: "account-a" },
    accountRefById: new Map([["account-a", "10"]]),
    taxByRate: new Map([["0", { id: "arbitrary-zero-rate-code", rate: "0" }]]),
  } as unknown as NativeContext;
  const built = buildNativeFromNetSuite(
    taxContext,
    {
      ...header,
      ttype: "VendBill",
    },
    [
      {
        transaction: "123",
        id: "1",
        mainline: "T",
        taxline: "F",
        account: "10",
        netamount: "-100",
        subsidiary: "1",
      },
      {
        transaction: "123",
        id: "2",
        mainline: "F",
        taxline: "F",
        account: "20",
        netamount: "100",
        taxrate1: "0",
        subsidiary: "1",
      },
    ],
  );
  assert.ok(!("skip" in built));
  assert.equal(built.doc.lines[0]?.taxAmount, "0");
  assert.equal(built.doc.lines[0]?.taxCodeId, null);
});

test("NetSuite non-zero tax uses the exact source tax code before rate fallback", () => {
  const taxContext = {
    ...context,
    control: { ar: "account-a", ap: "account-a", bank: "account-a" },
    accountRefById: new Map([["account-a", "10"]]),
    taxByRate: new Map([["13", { id: "rate-fallback", rate: "13" }]]),
    taxCodeByRef: new Map([["2529", "source-hst-code"]]),
  } as unknown as NativeContext;
  const built = buildNativeFromNetSuite(
    taxContext,
    {
      ...header,
      ttype: "CustInvc",
    },
    [
      {
        transaction: "123",
        id: "0",
        mainline: "T",
        taxline: "F",
        account: "10",
        netamount: "113",
        subsidiary: "1",
      },
      {
        transaction: "123",
        id: "1",
        mainline: "F",
        taxline: "F",
        account: "20",
        netamount: "-100",
        taxrate1: "0.13",
        taxcode: "2529",
        subsidiary: "1",
      },
      {
        transaction: "123",
        id: "2",
        mainline: "F",
        taxline: "T",
        account: "10",
        netamount: "-13",
        subsidiary: "1",
      },
    ],
  );
  assert.ok(!("skip" in built));
  assert.equal(built.doc.lines[0]?.taxCodeId, "source-hst-code");
  assert.equal(built.doc.lines[0]?.taxAmount, "13.0000");
});

test("NetSuite non-zero source tax codes fail closed when they were not loaded", () => {
  const built = buildNativeFromNetSuite(
    context,
    {
      ...header,
      ttype: "CustInvc",
    },
    [
      {
        transaction: "123",
        id: "1",
        mainline: "F",
        taxline: "F",
        account: "20",
        netamount: "-100",
        taxrate1: "0.13",
        taxcode: "missing",
        subsidiary: "1",
      },
    ],
  );
  assert.deepEqual(built, { skip: "unmapped tax code missing" });
});

test("NetSuite account mappings accept explicit custom IDs without connector constants", () => {
  assert.deepEqual(
    parseNetSuiteMappings(
      JSON.stringify({
        projectForemanField: "custentity_foreman",
        timeTypeRecord: "customrecord_time_type",
        projectStatuses: { "Substantially Complete": "substantially_complete" },
      }),
    ),
    {
      projectForemanField: "custentity_foreman",
      projectPurchaseOrderField: undefined,
      itemCategoryField: undefined,
      customerShortCodeField: undefined,
      employeeBenefitsField: undefined,
      timeTypeRecord: "customrecord_time_type",
      timeTypeMultiplierField: undefined,
      timeEntryTypeField: undefined,
      projectStatuses: { "substantially complete": "substantially_complete" },
    },
  );
  assert.throws(
    () => parseNetSuiteMappings('{"itemCategoryField":"x; DROP"}'),
    /invalid script ID/,
  );
  assert.throws(
    () => parseNetSuiteMappings('{"projectStatuses":{"Won":"won"}}'),
    /invalid target/,
  );
});

test("NetSuite high-volume streams partition every numeric ID exactly once", () => {
  assert.deepEqual(numericIdWindows(0), []);
  assert.deepEqual(numericIdWindows(12_001, 5_000), [
    [0, 5_000],
    [5_000, 10_000],
    [10_000, 12_001],
  ]);
  assert.throws(() => numericIdWindows(-1), /non-negative safe integer/);
  assert.throws(() => numericIdWindows(1, 0), /positive safe integer/);
});

test("NetSuite incremental watermarks use the transaction modification clock", () => {
  assert.match(
    NETSUITE_TRANSACTION_WATERMARK_QUERY,
    /MAX\(lastmodifieddate\)/i,
  );
  assert.doesNotMatch(NETSUITE_TRANSACTION_WATERMARK_QUERY, /SYSDATE/i);
});

test("NetSuite credit balances use exact mainline less Payment-link arithmetic", () => {
  assert.equal(netSuiteCreditOpenBalance("1129.55", "1129.5500"), "0.0000");
  assert.equal(netSuiteCreditOpenBalance("-479.07", "0"), "479.0700");
  assert.equal(netSuiteCreditOpenBalance("10", "10.01"), "0.0000");
});

test("NetSuite transaction lines are ingested exactly once and conflicts fail closed", () => {
  const row: NsLine = {
    transaction: "4803",
    id: "1",
    mainline: "F",
    taxline: "F",
    account: "53",
    netamount: "2473.89",
  };
  assert.deepEqual(uniqueNetSuiteTransactionLines([row, { ...row }]), [row]);
  assert.throws(
    () =>
      uniqueNetSuiteTransactionLines([row, { ...row, netamount: "2473.88" }]),
    /conflicting transaction line 4803:1/,
  );
});

test("NetSuite application links are ingested exactly once and conflicts fail closed", () => {
  const row = {
    previousdoc: "bill",
    previousline: "0",
    nextdoc: "payment",
    nextline: "1",
    foreignamount: "50.00",
  };
  assert.deepEqual(uniqueNetSuiteApplicationLinks([row, { ...row }]), [row]);
  assert.throws(
    () =>
      uniqueNetSuiteApplicationLinks([row, { ...row, foreignamount: "49.99" }]),
    /conflicting application link bill:0:payment:1/,
  );
});
