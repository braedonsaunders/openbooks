import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeFromNetSuite, type NsHeader, type NsLine } from "./netsuite-native.ts";
import { numericIdWindows, parseNetSuiteMappings } from "./netsuite-source.ts";
import type { NativeContext } from "./native.ts";

const context = {
  accountByRef: new Map([
    ["10", { id: "account-a", number: "1000", name: "Cash", type: "asset_bank" }],
    ["20", { id: "account-b", number: "6000", name: "Expense", type: "expense" }],
  ]),
  subsidiaryByRef: new Map([
    ["1", "sub-root"],
    ["2", "sub-child"],
  ]),
  partyByRef: new Map(),
  deptByRef: new Map(),
  projectByRef: new Map(),
  taxByRate: new Map(),
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
      transaction: "123", id: "1", mainline: "T", taxline: "F",
      account: "10", netamount: "-100", subsidiary: "1",
    },
    {
      transaction: "123", id: "2", mainline: "F", taxline: "F",
      account: "20", netamount: "100", subsidiary: "2",
    },
  ];
  const built = buildNativeFromNetSuite(context, header, lines);
  assert.ok(!("skip" in built));
  assert.equal(built.doc.subsidiaryId, "sub-root");
  assert.deepEqual(built.doc.lines.map((line) => line.subsidiaryId), ["sub-root", "sub-child"]);
});

test("NetSuite transactions fail closed when a subsidiary was not loaded", () => {
  const lines: NsLine[] = [{
    transaction: "123", id: "1", mainline: "T", taxline: "F",
    account: "10", netamount: "0", subsidiary: "99",
  }];
  const built = buildNativeFromNetSuite(context, header, lines);
  assert.deepEqual(built, { skip: "unmapped subsidiary 99" });
});

test("NetSuite account mappings accept explicit custom IDs without connector constants", () => {
  assert.deepEqual(parseNetSuiteMappings(JSON.stringify({
    projectForemanField: "custentity_foreman",
    timeTypeRecord: "customrecord_time_type",
    projectStatuses: { "Substantially Complete": "substantially_complete" },
  })), {
    projectForemanField: "custentity_foreman",
    projectPurchaseOrderField: undefined,
    itemCategoryField: undefined,
    customerShortCodeField: undefined,
    employeeBenefitsField: undefined,
    timeTypeRecord: "customrecord_time_type",
    timeTypeMultiplierField: undefined,
    timeEntryTypeField: undefined,
    projectStatuses: { "substantially complete": "substantially_complete" },
  });
  assert.throws(() => parseNetSuiteMappings('{"itemCategoryField":"x; DROP"}'), /invalid script ID/);
  assert.throws(() => parseNetSuiteMappings('{"projectStatuses":{"Won":"won"}}'), /invalid target/);
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
