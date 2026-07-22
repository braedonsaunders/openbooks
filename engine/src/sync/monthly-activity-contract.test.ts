import assert from "node:assert/strict";
import test from "node:test";
import type { QboClient } from "../qbo.ts";
import { ErpNextSource } from "./erpnext-source.ts";
import { NetSuiteSource } from "./netsuite-source.ts";
import { OdooSource } from "./odoo-source.ts";
import { QboSource } from "./qbo-source.ts";

test("NetSuite exposes posting account-month home-currency activity", async () => {
  const source = new NetSuiteSource({
    account: "test",
    host: "https://example.invalid",
    consumerKey: "test",
    consumerSecret: "test",
    tokenKey: "test",
    tokenSecret: "test",
  });
  (source as unknown as { q: (query: string) => Promise<Record<string, string>[]> }).q = async (query) => {
    assert.match(query, /transactionaccountingline/);
    assert.match(query, /tal\.posting = 'T'/);
    assert.match(query, /TO_CHAR\(t\.trandate, 'YYYY-MM'\)/);
    return [{ acct: "1000", m: "2026-01", d: "12.3456", c: "2.0001" }];
  };

  assert.deepEqual(await source.monthlyActivity(), [
    { accountRef: "1000", month: "2026-01", amount: "10.3455" },
  ]);
});

test("NetSuite item import carries simple cost and base price", async () => {
  const source = new NetSuiteSource({
    account: "test",
    host: "https://example.invalid",
    consumerKey: "test",
    consumerSecret: "test",
    tokenKey: "test",
    tokenSecret: "test",
  });
  (source as unknown as { q: (query: string) => Promise<Record<string, string>[]> }).q = async (query) => {
    if (/FROM pricing/i.test(query)) {
      assert.match(query, /quantity = 1/i);
      return [{ item: "2119", unitprice: "17.16" }];
    }
    assert.match(query, /cost, averagecost/i);
    return [{
      id: "2119", itemid: "PLUG", displayname: "Plug Stone", itemtype: "NonInvtPart",
      isinactive: "F", cost: "15.60", saleunit: "Each",
    }];
  };

  const records = await (source as unknown as { items: (since: Date | null) => Promise<Array<{ fields: Record<string, unknown> }>> }).items(null);
  assert.deepEqual(records[0]?.fields, {
    code: "PLUG",
    name: "Plug Stone",
    kind: "non_inventory",
    category: null,
    defaultCost: "15.6000",
    defaultRate: "17.1600",
    unit: "Each",
    isActive: true,
  });
});

test("Odoo exposes posted account-month home-currency activity", async () => {
  const source = new OdooSource({ url: "https://example.invalid", database: "test", username: "test", apiKey: "test" });
  (source as unknown as { client: { searchReadAll: (...args: unknown[]) => Promise<unknown[]> } }).client = {
    searchReadAll: async () => [
      { account_id: [10, "Cash"], date: "2026-01-10", balance: 12.3456 },
      { account_id: [10, "Cash"], date: "2026-01-31", balance: -2.0001 },
    ],
  };

  assert.deepEqual(await source.monthlyActivity(), [
    { accountRef: "10", month: "2026-01", amount: "10.3455" },
  ]);
});

test("ERPNext exposes uncancelled account-month home-currency activity", async () => {
  const source = new ErpNextSource({ url: "https://example.invalid", apiKey: "test", apiSecret: "test" });
  (source as unknown as { client: { listAll: (...args: unknown[]) => Promise<unknown[]> } }).client = {
    listAll: async () => [
      { account: "Cash - CO", posting_date: "2026-02-01", debit: 15.4321, credit: 0 },
      { account: "Cash - CO", posting_date: "2026-02-20", debit: 0, credit: 3.21 },
    ],
  };

  assert.deepEqual(await source.monthlyActivity(), [
    { accountRef: "Cash - CO", month: "2026-02", amount: "12.2221" },
  ]);
});

test("QuickBooks exposes transaction account-month home-currency activity", async () => {
  const client = {
    report: async (name: string, params: Record<string, string>) => {
      assert.equal(name, "GeneralLedger");
      assert.equal(params.accounting_method, "Accrual");
      return {
        Rows: {
          Row: [
            { ColData: [
              { value: "2026-03-01" }, { id: "txn-1" }, {}, {}, { id: "42" }, { value: "20.25" }, { value: "0" },
            ] },
            { ColData: [
              { value: "2026-03-31" }, { id: "txn-2" }, {}, {}, { id: "42" }, { value: "0" }, { value: "5.25" },
            ] },
          ],
        },
      };
    },
  } as unknown as QboClient;
  const source = new QboSource(client);

  assert.deepEqual(await source.monthlyActivity(), [
    { accountRef: "42", month: "2026-03", amount: "15.0000" },
  ]);
});
