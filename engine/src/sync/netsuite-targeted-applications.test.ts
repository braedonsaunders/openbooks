import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { NetSuiteSource } from "./netsuite-source.ts";

const creds = {
  account: "TEST",
  host: "https://test.example.invalid",
  consumerKey: "consumer",
  consumerSecret: "secret",
  tokenKey: "token",
  tokenSecret: "token-secret",
};

test("targeted NetSuite pulls include payment links touching either document side", async () => {
  const queries: string[] = [];
  const source = new NetSuiteSource(creds, { baseCurrency: "USD" });
  Object.defineProperty(source, "q", {
    value: async (query: string) => {
      queries.push(query);
      if (/MAX\(lastmodifieddate\)/i.test(query)) {
        return [{ now: "2026-07-31 12:00:00" }];
      }
      if (/nexttransactionlinelink/i.test(query)) {
        return [
          {
            previousdoc: "10",
            previousline: "1",
            nextdoc: "20",
            nextline: "2",
            foreignamount: "25.0000",
            paycurrency: "CAD",
            payexrate: "1",
          },
        ];
      }
      return [];
    },
  });

  const changes = await source.nativeTransactionsByIds(
    ["10"],
    {} as NativeContext,
  );

  assert.deepEqual(changes.applications, [
    { paymentRef: "20", appliedRef: "10", amount: "25.0000", currency: "CAD", rate: "1" },
  ]);
  assert.match(
    queries.find((query) => /nexttransactionlinelink/i.test(query))!,
    /n\.nextdoc IN \(10\) OR n\.previousdoc IN \(10\)/,
  );
});

test("incremental NetSuite mirrors fetch a complete allocation graph even without changed transactions", async () => {
  const source = new NetSuiteSource(creds, { baseCurrency: "CAD" });
  const exports: { id: string; sql: string }[][] = [];
  Object.defineProperty(source, "q", { value: async (query: string) => {
    if (/MAX\(lastmodifieddate\)/i.test(query)) return [{ now: "2026-07-31 12:00:00" }];
    if (/COUNT\(\*\)/i.test(query)) return [{ n: "0" }];
    return [];
  }});
  Object.defineProperty(source, "bridge", { value: {
    deletedRecords: async () => [],
    bulkQuery: async (partitions: { id: string; sql: string }[]) => {
      exports.push(partitions);
      return new Map([["applications", [
        { previousdoc: "bill", previousline: "0", nextdoc: "payment", nextline: "1", foreignamount: "0", paycurrency: "CAN", payexrate: "1" },
        { previousdoc: "void-journal", previousline: "1", nextdoc: "payment", nextline: "1", foreignamount: "611.52", paycurrency: "CAN", payexrate: "1" },
      ]]]);
    },
  }});
  const result = await source.nativeChanges(new Date("2026-07-31T11:59:00Z"), {} as NativeContext);
  assert.equal(result.documents.length, 0);
  assert.equal(result.applicationSnapshot, "complete");
  assert.deepEqual(result.applications, [
    { paymentRef: "payment", appliedRef: "void-journal", amount: "611.52", currency: "CAD", rate: "1" },
  ]);
  assert.equal(exports.length, 1);
  assert.equal(exports[0]![0]!.id, "applications");
  assert.doesNotMatch(exports[0]![0]!.sql, /lastmodifieddate|IN\s*\(/i);
});

test("a missing NetSuite allocation export refuses instead of authorizing an empty graph", async () => {
  const source = new NetSuiteSource(creds, { baseCurrency: "CAD" });
  Object.defineProperty(source, "q", { value: async (query: string) => {
    if (/MAX\(lastmodifieddate\)/i.test(query)) return [{ now: "2026-07-31 12:00:00" }];
    if (/COUNT\(\*\)/i.test(query)) return [{ n: "0" }];
    return [];
  }});
  Object.defineProperty(source, "bridge", { value: { bulkQuery: async () => new Map() }});
  await assert.rejects(() => source.nativeChanges(new Date(), {} as NativeContext), /application export is incomplete/);
});
