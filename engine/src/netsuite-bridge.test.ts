import assert from "node:assert/strict";
import test from "node:test";
import { NetSuiteBridgeClient } from "./netsuite-bridge.ts";
import type { NetSuiteCreds } from "./netsuite.ts";

const creds: NetSuiteCreds = {
  account: "test",
  host: "https://example.invalid",
  consumerKey: "consumer",
  consumerSecret: "secret",
  tokenKey: "token",
  tokenSecret: "secret",
};

test("NetSuite bridge client exhausts deterministic pages", async () => {
  const requested: number[] = [];
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    const pageIndex = Number(params.pageIndex);
    requested.push(pageIndex);
    return {
      schemaVersion: 1,
      pageIndex,
      pageSize: 2,
      totalRows: 3,
      hasMore: pageIndex === 0,
      rows: pageIndex === 0 ? [{ id: "1" }, { id: "2" }] : [{ id: "3" }],
    } as T;
  });

  assert.deepEqual(await client.query<{ id: string }>("SELECT id FROM account"), [
    { id: "1" }, { id: "2" }, { id: "3" },
  ]);
  assert.deepEqual(requested, [0, 1]);
});

test("NetSuite bridge client fails closed on script errors and incompatible schemas", async () => {
  const failed = new NetSuiteBridgeClient(creds, {}, async <T>() => ({
    ok: false, schemaVersion: 1, name: "QUERY_ERROR", error: "field is unavailable",
  }) as T);
  await assert.rejects(() => failed.query("SELECT bad FROM account"), /field is unavailable/);

  const incompatible = new NetSuiteBridgeClient(creds, {}, async <T>() => ({
    schemaVersion: 2, pageIndex: 0, pageSize: 1, totalRows: 0, hasMore: false, rows: [],
  }) as T);
  await assert.rejects(() => incompatible.query("SELECT id FROM account"), /incompatible/);
});

test("NetSuite bridge deletion feed preserves tombstone identity", async () => {
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    assert.equal(params.action, "deleted");
    assert.equal(params.recordType, "transaction");
    return {
      schemaVersion: 1,
      rows: [{ internalId: "42", deletedAt: "7/19/2026", recordType: "Invoice", name: "INV42", externalId: "" }],
    } as T;
  });
  assert.deepEqual(await client.deletedRecords(new Date("2026-07-19T00:00:00Z"), "transaction"), [
    { internalId: "42", deletedAt: "7/19/2026", recordType: "Invoice", name: "INV42", externalId: "" },
  ]);
});
