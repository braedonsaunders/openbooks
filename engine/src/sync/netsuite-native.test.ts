import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNativeFromNetSuite,
  netSuiteBillAmount,
  normalizeMarkupPercent,
  type NsHeader,
  type NsLine,
} from "./netsuite-native.ts";
import {
  NETSUITE_TRANSACTION_WATERMARK_QUERY,
  netSuiteCreditOpenBalance,
  netSuiteLineColumns,
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
  itemByRef: new Map([["item-1", "item-a"]]),
  deptByRef: new Map(),
  projectByRef: new Map(),
  taxByRate: new Map(),
  taxCodeByRef: new Map(),
  periodByRef: new Map([
    [
      "17",
      {
        id: "period-july",
        startsOn: "2026-07-01",
        endsOn: "2026-07-31",
        isAdjustment: false,
      },
    ],
    [
      "18",
      {
        id: "period-adjustment",
        startsOn: "2026-07-01",
        endsOn: "2026-07-31",
        isAdjustment: true,
      },
    ],
  ]),
} as unknown as NativeContext;

const header: NsHeader = {
  id: "123",
  tranid: "JRN-0042",
  ttype: "Journal",
  trandate: "07/15/2026",
  posting: "T",
  postingperiod: "17",
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
  assert.equal(built.doc.documentNumber, "JRN-0042");
  assert.equal(built.doc.posting, true);
  assert.equal(built.doc.postingPeriodId, "period-july");
  assert.equal(built.doc.postingDate, "2026-07-15");
  assert.equal(built.doc.subsidiaryId, "sub-root");
  assert.deepEqual(
    built.doc.lines.map((line) => line.subsidiaryId),
    ["sub-root", "sub-child"],
  );
});

test("NetSuite posting transactions fail closed without an exact source period", () => {
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
      subsidiary: "1",
    },
  ];
  assert.deepEqual(
    buildNativeFromNetSuite(context, { ...header, postingperiod: null }, lines),
    { skip: "posting transaction has no source posting period" },
  );
  assert.deepEqual(
    buildNativeFromNetSuite(context, { ...header, postingperiod: "99" }, lines),
    { skip: "unmapped posting period 99" },
  );
});

test("NetSuite payments preserve additional non-control GL legs", () => {
  const paymentContext = {
    ...context,
    accountByRef: new Map([
      ...context.accountByRef,
      [
        "30",
        {
          id: "account-ap",
          number: "2000",
          name: "Accounts Payable",
          type: "liability_payable",
        },
      ],
    ]),
    accountRefById: new Map([
      ["account-ap", "30"],
      ["account-a", "10"],
      ["account-b", "20"],
    ]),
    control: {
      ar: "account-ar",
      ap: "account-ap",
      bank: "account-a",
    },
  } as unknown as NativeContext;
  const lines: NsLine[] = [
    {
      transaction: "5001",
      id: "1",
      mainline: "T",
      taxline: "F",
      account: "30",
      netamount: "100",
    },
    {
      transaction: "5001",
      id: "2",
      mainline: "F",
      taxline: "F",
      account: "10",
      netamount: "-95",
    },
    {
      transaction: "5001",
      id: "3",
      mainline: "F",
      taxline: "F",
      account: "20",
      netamount: "-5",
    },
  ];

  const built = buildNativeFromNetSuite(
    paymentContext,
    {
      id: "5001",
      tranid: "VP-5001",
      ttype: "VendPymt",
      trandate: "07/15/2026",
      posting: "T",
      postingperiod: "17",
    },
    lines,
  );

  assert.ok(!("skip" in built));
  assert.equal(built.doc.kind, "journal");
  assert.deepEqual(
    built.doc.lines.map((line) => [line.accountId, line.amount]),
    [
      ["account-ap", "100.0000"],
      ["account-a", "-95.0000"],
      ["account-b", "-5.0000"],
    ],
  );
  assert.equal(built.doc.subtotal, "0.0000");
  assert.equal(built.doc.total, "0.0000");
});

test("NetSuite two-leg payments retain their payment kind", () => {
  const paymentContext = {
    ...context,
    accountByRef: new Map([
      ...context.accountByRef,
      [
        "30",
        {
          id: "account-ap",
          number: "2000",
          name: "Accounts Payable",
          type: "liability_payable",
        },
      ],
    ]),
    accountRefById: new Map([
      ["account-ap", "30"],
      ["account-a", "10"],
    ]),
    control: {
      ar: "account-ar",
      ap: "account-ap",
      bank: "account-a",
    },
  } as unknown as NativeContext;
  const built = buildNativeFromNetSuite(
    paymentContext,
    {
      id: "5002",
      tranid: "VP-5002",
      ttype: "VendPymt",
      trandate: "07/15/2026",
      posting: "T",
      postingperiod: "17",
    },
    [
      {
        transaction: "5002",
        id: "1",
        mainline: "T",
        taxline: "F",
        account: "30",
        netamount: "100",
      },
      {
        transaction: "5002",
        id: "2",
        mainline: "F",
        taxline: "F",
        account: "10",
        netamount: "-100",
      },
    ],
  );

  assert.ok(!("skip" in built));
  assert.equal(built.doc.kind, "vendor_payment");
  assert.deepEqual(
    built.doc.lines.map((line) => [line.accountId, line.amount]),
    [["account-a", "100.0000"]],
  );
});

test("pending NetSuite expense reports remain pending native expense reports", () => {
  const expenseContext = {
    ...context,
    accountByRef: new Map([
      ...context.accountByRef,
      [
        "448",
        {
          id: "card-control",
          number: "2200",
          name: "Corporate Card",
          type: "liability_credit_card",
        },
      ],
      [
        "222",
        {
          id: "rental-expense",
          number: "5055",
          name: "Outside Equipment Rentals",
          type: "expense",
        },
      ],
    ]),
    partyByRef: new Map([["501", "employee-1"]]),
    projectByRef: new Map([["601", "project-1"]]),
    taxCodeByRef: new Map([["2529", "hst-code"]]),
    taxByRate: new Map([["13", { id: "hst-code", rate: "13" }]]),
  } as unknown as NativeContext;
  const lines: NsLine[] = [
    {
      transaction: "4001",
      id: "0",
      mainline: "T",
      taxline: "F",
      expenseaccount: "10",
      foreignamount: "0",
      entity: "501",
      subsidiary: "1",
    },
    {
      transaction: "4001",
      id: "1",
      mainline: "F",
      taxline: "F",
      expenseaccount: "448",
      foreignamount: "-1311.15",
      settlementamount: "-1311.15",
      entity: "501",
      subsidiary: "1",
    },
    {
      transaction: "4001",
      id: "2",
      mainline: "F",
      taxline: "F",
      expenseaccount: "222",
      foreignamount: "1160.31",
      taxrate1: "0.13",
      taxcode: "2529",
      entity: "601",
      subsidiary: "1",
      isbillable: "T",
      markup: "15",
      memo: "Equipment rental",
    },
    {
      transaction: "4001",
      id: "6",
      mainline: "F",
      taxline: "T",
      expenseaccount: "20",
      foreignamount: "150.84",
      subsidiary: "1",
    },
  ];

  const built = buildNativeFromNetSuite(
    expenseContext,
    {
      id: "4001",
      tranid: "ER-42",
      ttype: "ExpRept",
      trandate: "07/27/2026",
      entity: "501",
      posting: "F",
      approvalstatus: "1",
      postingperiod: null,
    },
    lines,
  );

  assert.ok(!("skip" in built));
  assert.equal(built.doc.kind, "expense_report");
  assert.equal(built.doc.documentNumber, "ER-42");
  assert.equal(built.doc.partyId, "employee-1");
  assert.equal(built.doc.posting, false);
  assert.equal(built.doc.lifecycleStatus, "pending_approval");
  assert.equal(built.doc.postingPeriodId, null);
  assert.equal(built.doc.controlAccountId, "card-control");
  assert.equal(built.doc.subtotal, "1160.3100");
  assert.equal(built.doc.total, "1311.1500");
  assert.equal(built.doc.lines.length, 1);
  assert.deepEqual(
    {
      sourceLineRef: built.doc.lines[0]?.sourceLineRef,
      projectId: built.doc.lines[0]?.projectId,
      amount: built.doc.lines[0]?.amount,
      taxAmount: built.doc.lines[0]?.taxAmount,
      isBillable: built.doc.lines[0]?.isBillable,
      markupPercent: built.doc.lines[0]?.markupPercent,
      billAmount: built.doc.lines[0]?.billAmount,
    },
    {
      sourceLineRef: "2",
      projectId: "project-1",
      amount: "1160.3100",
      taxAmount: "150.8400",
      isBillable: true,
      markupPercent: "15.0000",
      billAmount: "1334.3565",
    },
  );

  const posted = buildNativeFromNetSuite(
    expenseContext,
    {
      id: "4001",
      tranid: "ER-42",
      ttype: "ExpRept",
      trandate: "07/27/2026",
      entity: "501",
      posting: "T",
      approvalstatus: "2",
      postingperiod: "17",
    },
    lines,
  );
  assert.ok(!("skip" in posted));
  assert.equal(posted.doc.posting, true);
  assert.equal(posted.doc.lifecycleStatus, "approved");
  assert.equal(posted.doc.controlAccountId, "card-control");
  assert.equal(posted.doc.lines.length, 1);
});

test("NetSuite commercial amounts use exact percentages and refund face value", () => {
  assert.equal(normalizeMarkupPercent("15"), "15.0000");
  assert.equal(normalizeMarkupPercent("0.15"), "15.0000");
  assert.equal(normalizeMarkupPercent("1"), "100.0000");
  assert.equal(normalizeMarkupPercent("-0.15"), null);
  assert.equal(
    netSuiteBillAmount("expense_report", "1160.3100", true, "15.0000"),
    "1334.3565",
  );
  assert.equal(
    netSuiteBillAmount("card_refund", "-118.5300", true, "15.0000"),
    "-118.5300",
  );
  assert.equal(
    netSuiteBillAmount("expense_report", "1160.3100", false, "15.0000"),
    null,
  );
});

test("NetSuite preserves source date independently from exact posting period", () => {
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
      subsidiary: "1",
    },
  ];
  const late = buildNativeFromNetSuite(
    context,
    {
      ...header,
      trandate: "06/30/2026",
      postingperiod: "17",
    },
    lines,
  );
  assert.ok(!("skip" in late));
  assert.equal(late.doc.documentDate, "2026-06-30");
  assert.equal(late.doc.postingDate, "2026-06-30");
  assert.equal(late.doc.postingPeriodId, "period-july");

  const adjustment = buildNativeFromNetSuite(
    context,
    { ...header, postingperiod: "18" },
    lines,
  );
  assert.ok(!("skip" in adjustment));
  assert.equal(adjustment.doc.documentDate, "2026-07-15");
  assert.equal(adjustment.doc.postingDate, "2026-07-15");
  assert.equal(adjustment.doc.postingPeriodId, "period-adjustment");
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

test("NetSuite invoice lines preserve item, quantity, unit, rate, amount, and source identity", () => {
  const built = buildNativeFromNetSuite(
    context,
    { ...header, ttype: "CustInvc" },
    [
      {
        transaction: "123",
        id: "7",
        mainline: "F",
        taxline: "F",
        account: "20",
        item: "item-1",
        quantity: "-2",
        rate: "95.7",
        units: "Hour",
        foreignamount: "-191.4",
        subsidiary: "1",
      },
    ],
  );
  assert.ok(!("skip" in built));
  assert.deepEqual(
    {
      itemId: built.doc.lines[0]?.itemId,
      quantity: built.doc.lines[0]?.quantity,
      unit: built.doc.lines[0]?.unit,
      unitPrice: built.doc.lines[0]?.unitPrice,
      amount: built.doc.lines[0]?.amount,
      sourceLineRef: built.doc.lines[0]?.sourceLineRef,
    },
    {
      itemId: "item-a",
      quantity: "2.00000000",
      unit: "Hour",
      unitPrice: "95.70000000",
      amount: "191.4000",
      sourceLineRef: "7",
    },
  );
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

test("NetSuite orders retain exact source-code tax in document direction", () => {
  const taxContext = {
    ...context,
    taxByRate: new Map([["13", { id: "rate-fallback", rate: "13" }]]),
    taxCodeByRef: new Map([["2529", "source-hst-code"]]),
  } as unknown as NativeContext;
  const built = buildNativeFromNetSuite(
    taxContext,
    { ...header, ttype: "SalesOrd", posting: "F" },
    [
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
    ],
  );
  assert.ok(!("skip" in built));
  assert.equal(built.doc.lines[0]?.taxCodeId, "source-hst-code");
  assert.equal(built.doc.lines[0]?.taxAmount, "13.0000");
  assert.equal(built.doc.subtotal, "100.0000");
  assert.equal(built.doc.total, "113.0000");
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
        lineBillableField: "custcol_billable_override",
        timeTypeRecord: "customrecord_time_type",
        timeEntryFieldTicketNumberField: "custcol_field_ticket",
        projectStatuses: { "Substantially Complete": "substantially_complete" },
      }),
    ),
    {
      projectForemanField: "custentity_foreman",
      lineMarkupField: undefined,
      lineBillableField: "custcol_billable_override",
      projectPurchaseOrderField: undefined,
      itemCategoryField: undefined,
      customerShortCodeField: undefined,
      employeeBenefitsField: undefined,
      timeTypeRecord: "customrecord_time_type",
      timeTypeMultiplierField: undefined,
      timeEntryTypeField: undefined,
      timeEntryFieldTicketNumberField: "custcol_field_ticket",
      projectStatuses: { "substantially complete": "substantially_complete" },
      projectBillingTypes: undefined,
    },
  );
  assert.throws(
    () => parseNetSuiteMappings('{"itemCategoryField":"x; DROP"}'),
    /invalid script ID/,
  );
  assert.throws(
    () => parseNetSuiteMappings('{"lineBillableField":"x; DROP"}'),
    /invalid script ID/,
  );
  assert.throws(
    () => parseNetSuiteMappings('{"projectStatuses":{"Won":"won"}}'),
    /invalid target/,
  );
});

test("NetSuite job billing types read stock unless the account maps them", () => {
  // NetSuite's stock enum: time-and-materials plus two fixed-bid members. An
  // account that overloads a fixed-bid member for budget/do-not-exceed work
  // says so on its own connection — the shared connector must not assume it.
  assert.equal(parseNetSuiteMappings("{}").projectBillingTypes, undefined);
  assert.deepEqual(
    parseNetSuiteMappings('{"projectBillingTypes":{"fbm":"not_to_exceed"}}').projectBillingTypes,
    { FBM: "not_to_exceed" },
  );
  assert.throws(
    () => parseNetSuiteMappings('{"projectBillingTypes":{"FBM":"budget_dne"}}'),
    /invalid target/,
  );
});

test("NetSuite line billability can use a mapped tenant field with a native fallback", () => {
  assert.match(
    netSuiteLineColumns({
      lineBillableField: "custcol_billable_override",
      lineMarkupField: "custcol_markup",
    }),
    /COALESCE\(custcol_billable_override, tl\.isbillable\) AS isbillable/,
  );
  assert.match(
    netSuiteLineColumns({
      lineBillableField: "custcol_billable_override",
      lineMarkupField: "custcol_markup",
    }),
    /custcol_markup AS markup/,
  );
  assert.match(
    netSuiteLineColumns({}),
    /tl\.isbillable/,
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
