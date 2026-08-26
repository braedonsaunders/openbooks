import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient, QueryResult } from "pg";
import { db, pool } from "../engine/src/db.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../engine/src/test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type SettledUpdate = PromiseSettledResult<QueryResult>;

const settleUpdate = (promise: Promise<QueryResult>): Promise<SettledUpdate> =>
  promise.then(
    (value): SettledUpdate => ({ status: "fulfilled", value }),
    (reason): SettledUpdate => ({ status: "rejected", reason }),
  );

async function openRateTransaction(): Promise<{ client: PoolClient; pid: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    const backend = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    return { client, pid: Number(backend.rows[0]!.pid) };
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
}

async function observeFence(
  blockerPid: number,
  waiterPid: number,
  update: Promise<SettledUpdate>,
): Promise<{ blocked: boolean; result?: SettledUpdate }> {
  let result: SettledUpdate | undefined;
  void update.then((settled) => {
    result = settled;
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (result) return { blocked: false, result };
    const lockState = await pool.query<{ blocked: boolean }>(
      "select $1::int = any(pg_blocking_pids($2::int)) as blocked",
      [blockerPid, waiterPid],
    );
    if (lockState.rows[0]?.blocked) return { blocked: true };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out observing the rate-book fence for backend ${waiterPid}`);
}

interface BookFixture {
  orgId: string;
  actorId: string;
  bookId: string;
  itemId: string;
}

async function seedBook(name: string): Promise<BookFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const bookId = randomUUID();
  await db.execute(sql`
    insert into item_rate_books (org_id, id, code, name, currency, is_default, is_active, created_by, updated_by)
    values (${org.orgId}, ${bookId}, ${name}, ${name}, 'CAD', false, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, bookId, itemId: org.items.service };
}

/** The exact unit the item-rates route persists, issued as a direct writer. */
async function insertFirstVersion(
  client: PoolClient,
  fixture: BookFixture,
  versionId: string,
): Promise<void> {
  await client.query(
    `insert into item_rate_versions (org_id, id, rate_book_id, effective_from, status, custom, created_by, updated_by)
     values ($1, $2, $3, '2026-07-01', 'draft', '{}'::jsonb, $4, $4)`,
    [fixture.orgId, versionId, fixture.bookId, fixture.actorId],
  );
  await client.query(
    `insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate, time_type_bill_rates, sort_order, created_by, updated_by)
     values ($1, $2, $3, 'hour', 'Hour', 1, 75, 125, '{}'::jsonb, 0, $4, $4)`,
    [fixture.orgId, versionId, fixture.itemId, fixture.actorId],
  );
  await client.query(
    `insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
     values ($1, 'item_rate_versions', $2, 'insert', '{}'::jsonb, $3)`,
    [fixture.orgId, versionId, fixture.actorId],
  );
}

test(
  "a currency change cannot pass the history check while first-version creation is in flight",
  { skip: !DB },
  async () => {
    const fixture = await seedBook("RACE");
    const creation = await openRateTransaction();
    const currencyPatch = await openRateTransaction();
    let creationOpen = true;
    let patchOpen = true;
    try {
      const versionId = randomUUID();
      // First-version creation paused after its book read: the insert is
      // issued and uncommitted, exactly the window rate_book_currency_guard
      // used to miss under READ COMMITTED snapshots.
      await insertFirstVersion(creation.client, fixture, versionId);
      const update = settleUpdate(
        currencyPatch.client.query(
          "update item_rate_books set currency = $1 where org_id = $2 and id = $3",
          ["USD", fixture.orgId, fixture.bookId],
        ),
      );
      const observation = await observeFence(creation.pid, currencyPatch.pid, update);
      assert.equal(
        observation.blocked,
        true,
        "the currency PATCH must wait while first-version creation is in flight",
      );
      await creation.client.query("commit");
      creationOpen = false;
      const settled = observation.result ?? (await update);
      assert.equal(settled.status, "rejected", "the currency PATCH must be rejected");
      if (settled.status === "rejected") {
        assert.match(
          String(settled.reason),
          /rate book currency cannot change after version history exists/,
        );
      }
      await currencyPatch.client.query("rollback");
      patchOpen = false;

      const book = (await db.execute<{ currency: string }>(sql`
        select currency from item_rate_books where id = ${fixture.bookId}`));
      assert.equal(
        book.rows[0]?.currency,
        "CAD",
        "exactly one currency generation survives the race",
      );

      // Subsequent changes remain rejected — including the Setup writer's
      // exact shape, which takes the advisory fence before the row lock.
      const setupShapedPatch = await openRateTransaction();
      try {
        await setupShapedPatch.client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`item-rate-books:${fixture.orgId}`],
        );
        await assert.rejects(
          setupShapedPatch.client.query(
            "update item_rate_books set currency = $1 where org_id = $2 and id = $3",
            ["EUR", fixture.orgId, fixture.bookId],
          ),
          /rate book currency cannot change after version history exists/,
        );
      } finally {
        await setupShapedPatch.client.query("rollback").catch(() => undefined);
        setupShapedPatch.client.release();
      }

      const finalBook = (await db.execute<{ currency: string }>(sql`
        select currency from item_rate_books where id = ${fixture.bookId}`));
      assert.equal(finalBook.rows[0]?.currency, "CAD");
    } finally {
      if (creationOpen) await creation.client.query("rollback").catch(() => undefined);
      if (patchOpen) await currencyPatch.client.query("rollback").catch(() => undefined);
      creation.client.release();
      currencyPatch.client.release();
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);

test(
  "version, lines, and audit stay atomic, so a rolled-back creation leaves the book relabelable",
  { skip: !DB },
  async () => {
    const fixture = await seedBook("ATOMIC");
    const versionId = randomUUID();
    const creation = await openRateTransaction();
    try {
      await insertFirstVersion(creation.client, fixture, versionId);
      await creation.client.query("rollback");
    } finally {
      creation.client.release();
    }

    const counts = (await db.execute<{ versions: number; lines: number; audit: number }>(sql`
      select
        (select count(*)::int from item_rate_versions where org_id = ${fixture.orgId} and rate_book_id = ${fixture.bookId}) as versions,
        (select count(*)::int from item_rate_lines where org_id = ${fixture.orgId} and version_id = ${versionId}) as lines,
        (select count(*)::int from audit_log where org_id = ${fixture.orgId} and table_name = 'item_rate_versions' and row_id = ${versionId}) as audit`));
    assert.equal(counts.rows[0]?.versions, 0);
    assert.equal(counts.rows[0]?.lines, 0);
    assert.equal(counts.rows[0]?.audit, 0);

    // No version history exists, so a currency change is a plain rename again.
    await db.execute(sql`
      update item_rate_books set currency = 'USD' where org_id = ${fixture.orgId} and id = ${fixture.bookId}`);
    const book = (await db.execute<{ currency: string }>(sql`
      select currency from item_rate_books where id = ${fixture.bookId}`));
    assert.equal(book.rows[0]?.currency, "USD");
    await dropScratchOrgReporting(fixture.orgId);
  },
);

test(
  "a version insert must reference a tenant-owned rate book",
  { skip: !DB },
  async () => {
    const fixture = await seedBook("TENANT");
    const otherOrg = await seedBook("OTHER");
    try {
      // Drizzle wraps driver errors, so match the whole rendered chain.
      await assert.rejects(
        db.execute(sql`
          insert into item_rate_versions (org_id, id, rate_book_id, effective_from, status, custom, created_by, updated_by)
          values (${otherOrg.orgId}, ${randomUUID()}, ${fixture.bookId}, '2026-07-01', 'draft', '{}'::jsonb, ${otherOrg.actorId}, ${otherOrg.actorId})`),
        (error: unknown) =>
          String(error).includes("rate version must reference a tenant-owned rate book")
          || String((error as { cause?: unknown }).cause ?? "").includes(
            "rate version must reference a tenant-owned rate book",
          ),
      );
    } finally {
      await dropScratchOrgReporting(fixture.orgId);
      await dropScratchOrgReporting(otherOrg.orgId);
    }
  },
);
