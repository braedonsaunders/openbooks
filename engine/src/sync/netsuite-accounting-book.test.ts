import assert from "node:assert/strict";
import test from "node:test";
import { NetSuiteSource } from "./netsuite-source.ts";

const creds = {
  account: "TEST",
  host: "https://test.example.invalid",
  consumerKey: "consumer",
  consumerSecret: "secret",
  tokenKey: "token",
  tokenSecret: "token-secret",
};

function sourceWithQuery(
  rows: Array<Record<string, unknown>>,
  accountingBookId?: string,
): NetSuiteSource {
  const source = new NetSuiteSource(creds, { accountingBookId });
  Object.defineProperty(source, "q", {
    value: async () => rows,
  });
  return source;
}

test("NetSuite auto-selects the sole posted accounting book", async () => {
  const source = sourceWithQuery([{ id: "7" }, { id: "7" }]);
  assert.equal(await source.accountingBookId(), "7");
});

test("NetSuite multi-book accounts fail closed without an explicit book", async () => {
  const source = sourceWithQuery([{ id: "1" }, { id: "2" }]);
  await assert.rejects(
    source.accountingBookId(),
    /multiple accounting books \(1, 2\)/,
  );
});

test("NetSuite verifies and uses an explicitly configured accounting book", async () => {
  const queries: string[] = [];
  const source = new NetSuiteSource(creds, { accountingBookId: "2" });
  Object.defineProperty(source, "q", {
    value: async (query: string) => {
      queries.push(query);
      if (/SELECT DISTINCT tal\.accountingbook AS id/i.test(query)) {
        return [{ id: "1" }, { id: "2" }];
      }
      return [{ acct: "4000", d: "10", c: "2" }];
    },
  });

  const balance = await source.trialBalance();
  assert.deepEqual(balance, [{ accountRef: "4000", balance: "8.0000" }]);
  assert.match(queries.at(-1)!, /tal\.accountingbook = 2/);
});

test("NetSuite rejects a configured book absent from posted accounting data", async () => {
  const source = sourceWithQuery([{ id: "1" }], "2");
  await assert.rejects(
    source.accountingBookId(),
    /configured NetSuite accounting book 2 has no posted accounting lines/,
  );
});

test("NetSuite accounting book IDs are injection-safe numeric identifiers", () => {
  assert.throws(
    () => new NetSuiteSource(creds, { accountingBookId: "1 OR 1=1" }),
    /must be numeric/,
  );
});
