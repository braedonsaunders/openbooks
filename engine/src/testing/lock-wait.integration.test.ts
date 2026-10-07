import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { env } from "../platform/db.ts";
import { waitForLockWaiter } from "./lock-wait.ts";

test("lock rendezvous ignores an unrelated blocker and observes its own waiter", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const clients = Array.from({ length: 3 }, () => new pg.Client({
    connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL ?? env.OPENBOOKS_DB_URL,
    connectionTimeoutMillis: 5_000, statement_timeout: 5_000,
  }));
  const [holder, otherHolder, waiter] = clients as [pg.Client, pg.Client, pg.Client];
  const opened: pg.Client[] = [];
  const ownKey = randomUUID(), otherKey = randomUUID();
  let pending: Promise<pg.QueryResult> | undefined;
  try {
    for (const client of clients) {
      await client.connect();
      opened.push(client);
      await client.query("begin");
    }
    await holder.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [ownKey]);
    await otherHolder.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [otherKey]);
    pending = waiter.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [otherKey]);
    void pending.catch(() => {});
    await waitForLockWaiter(otherHolder);
    await assert.rejects(waitForLockWaiter(holder, { timeoutMs: 100, intervalMs: 10 }), /no waiter blocked by this backend/);
    await otherHolder.query("rollback");
    await pending;
    pending = waiter.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [ownKey]);
    void pending.catch(() => {});
    await waitForLockWaiter(holder);
    await holder.query("rollback");
    await pending;
  } finally {
    for (const client of [holder, otherHolder].filter(client => opened.includes(client))) await client.query("rollback").catch(() => {});
    await pending?.catch(() => {});
    for (const client of clients) await client.end();
  }
});
