import assert from "node:assert/strict";
import test from "node:test";
import { buildNativeFromNetSuite, type NsHeader, type NsLine } from "./netsuite-native.ts";
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
