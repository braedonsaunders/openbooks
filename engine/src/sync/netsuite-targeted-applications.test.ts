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
  const source = new NetSuiteSource(creds);
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
    { paymentRef: "20", appliedRef: "10", amount: "25.0000" },
  ]);
  assert.match(
    queries.find((query) => /nexttransactionlinelink/i.test(query))!,
    /nextdoc IN \(10\) OR previousdoc IN \(10\)/,
  );
});
