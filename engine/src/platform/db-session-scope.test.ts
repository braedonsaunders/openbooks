import { strict as assert } from "node:assert";
import { test } from "node:test";
import pg from "pg";
import { pool, withOrgContext } from "./db.ts";

/**
 * Pooled queries skip the tenant-scope round trip only when the connection
 * already carries the scope this module applied. Every path that can leave
 * the session in another state must make the next query apply it again.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

type Recorded = { text: string; params?: unknown[] };

function fakeConnection(failOn?: RegExp) {
  const queries: Recorded[] = [];
  const client = {
    query(text: string | { text: string }, params?: unknown[]) {
      const sqlText = typeof text === "string" ? text : text.text;
      queries.push({ text: sqlText, params });
      if (failOn?.test(sqlText)) return Promise.reject(new Error("statement failed"));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {},
    on() { return client; },
    off() { return client; },
  };
  return { client, queries };
}

async function withConnection<T>(connection: ReturnType<typeof fakeConnection>, work: () => Promise<T>): Promise<T> {
  const original = pg.Pool.prototype.connect;
  pg.Pool.prototype.connect = (async () => connection.client) as unknown as typeof original;
  try {
    return await work();
  } finally {
    pg.Pool.prototype.connect = original;
  }
}

const scopeQueries = (queries: Recorded[]) =>
  queries.filter((query) => query.text.includes("set_config('app.current_org'")).map((query) => query.params?.[0]);

test("a connection already scoped to the organization runs the query without re-applying it", async () => {
  const connection = fakeConnection();
  await withConnection(connection, async () => {
    await withOrgContext(ORG_A, () => pool.query("select 1"));
    await withOrgContext(ORG_A, () => pool.query("select 2"));
    await withOrgContext(ORG_B, () => pool.query("select 3"));
    await withOrgContext(ORG_A, () => pool.query("select 4"));
  });
  assert.deepEqual(scopeQueries(connection.queries), [ORG_A, ORG_B, ORG_A]);
  assert.deepEqual(
    connection.queries.filter((query) => !query.text.includes("set_config")).map((query) => query.text),
    ["select 1", "select 2", "select 3", "select 4"],
  );
});

test("a connection handed to a caller is re-scoped before its next pooled query", async () => {
  const connection = fakeConnection();
  await withConnection(connection, async () => {
    await withOrgContext(ORG_A, () => pool.query("select 1"));
    await withOrgContext(ORG_A, async () => {
      const client = await pool.connect();
      await client.query("select set_config('app.current_org', '', false)");
      client.release();
    });
    await withOrgContext(ORG_A, () => pool.query("select 2"));
  });
  const applied = connection.queries.filter((query) => query.text.includes("set_config('app.current_org', $1, false)"));
  assert.equal(applied.length, 2, "the pooled query after the handout must apply the scope again");
  assert.equal(connection.queries.at(-1)?.text, "select 2");
  assert.ok(connection.queries.at(-2)?.text.includes("set_config('app.current_org', $1, false)"));
});

test("a statement that may change session settings forgets the applied scope", async () => {
  const connection = fakeConnection();
  await withConnection(connection, async () => {
    await withOrgContext(ORG_A, () => pool.query("select set_config('app.current_org', '', false)"));
    await withOrgContext(ORG_A, () => pool.query("select 1"));
    await withOrgContext(ORG_A, () => pool.query("RESET ALL"));
    await withOrgContext(ORG_A, () => pool.query("select 2"));
  });
  assert.deepEqual(scopeQueries(connection.queries).filter((org) => org !== undefined), [ORG_A, ORG_A, ORG_A]);
});

test("a failed statement forgets the applied scope", async () => {
  const connection = fakeConnection(/^select broken$/);
  await withConnection(connection, async () => {
    await withOrgContext(ORG_A, () => pool.query("select 1"));
    await assert.rejects(withOrgContext(ORG_A, () => pool.query("select broken")));
    await withOrgContext(ORG_A, () => pool.query("select 2"));
  });
  assert.deepEqual(scopeQueries(connection.queries), [ORG_A, ORG_A]);
});
