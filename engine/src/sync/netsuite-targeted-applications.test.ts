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

function allocationGraphSource(options: { count?: number; rows?: unknown[]; changedCount?: number } = {}) {
  const source = new NetSuiteSource(creds, { baseCurrency: "CAD" });
  const queries: string[] = [];
  let reads = 0;
  Object.defineProperty(source, "q", { value: async (query: string) => {
    queries.push(query);
    if (/MAX\(lastmodifieddate\)/i.test(query)) return [{ now: "2026-07-31 12:00:00" }];
    if (/nexttransactionlinelink/i.test(query)) {
      if (/COUNT\(\*\)/i.test(query)) {
        reads += 1;
        return [{ n: String(reads > 1 ? options.changedCount ?? options.count ?? 0 : options.count ?? 0) }];
      }
      return options.rows ?? [];
    }
    if (/COUNT\(\*\)/i.test(query)) return [{ n: "0" }];
    return [];
  }});
  Object.defineProperty(source, "bridge", { value: {
    deletedRecords: async () => [],
    bulkQuery: async () => { throw new Error("Allocation reads must not start an export task"); },
  }});
  return { source, queries };
}

test("incremental NetSuite mirrors fetch a complete allocation graph even without changed transactions", async () => {
  const { source, queries } = allocationGraphSource({ count: 2, rows: [
    { previousdoc: "bill", previousline: "0", nextdoc: "payment", nextline: "1", foreignamount: "0", paycurrency: "CAN", payexrate: "1" },
    { previousdoc: "void-journal", previousline: "1", nextdoc: "payment", nextline: "1", foreignamount: "611.52", paycurrency: "CAN", payexrate: "1" },
  ] });
  const result = await source.nativeChanges(new Date("2026-07-31T11:59:00Z"), {} as NativeContext);
  assert.equal(result.documents.length, 0);
  assert.equal(result.applicationSnapshot, "complete");
  assert.deepEqual(result.applications, [
    { paymentRef: "payment", appliedRef: "void-journal", amount: "611.52", currency: "CAD", rate: "1" },
  ]);
  const graphQueries = queries.filter(query=>/nexttransactionlinelink/i.test(query));
  assert.equal(graphQueries.length, 3);
  for (const query of graphQueries) assert.doesNotMatch(query, /lastmodifieddate|IN\s*\(/i);
});

test("an incomplete NetSuite allocation graph refuses instead of authorizing releases", async () => {
  const { source } = allocationGraphSource({ count: 1 });
  await assert.rejects(() => source.nativeChanges(new Date(), {} as NativeContext), /application graph is incomplete/);
});

test("a source graph changing during pagination refuses its allocation snapshot", async () => {
  const { source } = allocationGraphSource({ count: 0, changedCount: 1 });
  await assert.rejects(() => source.nativeChanges(new Date(), {} as NativeContext), /changed during reading/);
});

test("a confirmed empty source allocation graph remains authoritative", async () => {
  const { source } = allocationGraphSource();
  const changes = await source.nativeChanges(new Date(), {} as NativeContext);
  assert.equal(changes.applicationSnapshot, "complete");
  assert.deepEqual(changes.applications, []);
});
