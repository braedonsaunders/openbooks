/**
 * 0299 stages the non-negative CHECK as NOT VALID + VALIDATE (U11) while
 * preserving posted history it can no longer refuse (U14).
 *
 * A populated install may hold negative counted quantities on posted or
 * cancelled counts — immutable lines the engine refuses to re-record, where
 * a direct SQL edit would falsify the observation while leaving its movement
 * and GL history unexplained. The staged file marks those rows
 * is_pre_guard_legacy and exempts marked rows from the CHECK; negatives on
 * counts still open for correction refuse with the re-record remedy. New
 * negatives stay refused under the same constraint name.
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently. Each
 * test replays the real migration bytes through the real attempt executor
 * under a probe ledger name: the body is idempotent, so replaying it on an
 * already-migrated database is exactly what a runner retry does.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  connectMigrationClient,
  executeMigrationAttempt,
  executeMigrationBody,
  migrationLockConfig,
  releaseMigrationClient,
  sanitizeMigrationContent,
} from "../../../scripts/bootstrap-migration-client.ts";
import { db } from "../../../engine/src/platform/db.ts";
import { createStockCount } from "../../../engine/src/inventory/stock-counts.ts";
import { receiveInventory } from "../../../engine/src/inventory/movements.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";

const PROBE_FILENAME = "generated/0999_g43_0299_probe.sql";
const PROBE_DIGEST = "g43-0299-probe";

const migrationSql = readFileSync(
  new URL("./0299_stock_count_line_counted_nonnegative.sql", import.meta.url),
  "utf8",
);

async function receiveTen(org: ScratchOrg): Promise<void> {
  await receiveInventory(org.orgId, null, {
    itemId: org.items.fifo,
    stockLocationId: org.stockLocationId,
    quantity: "10",
    unitCost: "4",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
}

async function openCount(org: ScratchOrg): Promise<string> {
  const count = await createStockCount(org.orgId, null, {
    locationId: org.locationId,
    subsidiaryId: org.subsidiaryId,
    countedOn: org.date,
    lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
  });
  return count.id;
}

/** A negative observation written past the engine preflight exactly as the
 * historical bug left it. */
async function plantNegative(orgId: string, countId: string): Promise<void> {
  await db.execute(sql`
    update stock_count_lines set counted_quantity = '-1'
     where org_id = ${orgId} and stock_count_id = ${countId}
  `);
}

async function setCountStatus(orgId: string, countId: string, status: string): Promise<void> {
  await db.execute(sql`
    update stock_counts set status = ${status}
     where org_id = ${orgId} and id = ${countId}
  `);
}

async function runStagedFile(): Promise<void> {
  const client = await connectMigrationClient();
  try {
    await executeMigrationAttempt(client, {
      filename: PROBE_FILENAME,
      body: sanitizeMigrationContent(migrationSql),
      transactional: true,
      lock: migrationLockConfig({}),
      digest: PROBE_DIGEST,
      executeBody: (migrationClient, body, step) =>
        executeMigrationBody(migrationClient, body, step),
    });
  } finally {
    await releaseMigrationClient(client);
  }
}

async function clearProbeLedger(): Promise<void> {
  const client = await connectMigrationClient();
  try {
    await client.query("delete from public._applied_migrations where filename = $1", [PROBE_FILENAME]);
  } finally {
    await releaseMigrationClient(client);
  }
}

/** Return the guard to its pre-0299 state so the test proves the staged
 * build from scratch on any database. */
async function resetToPre0299(): Promise<void> {
  const client = await connectMigrationClient();
  try {
    await client.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.stock_count_lines'::regclass
           AND conname = 'stock_count_lines_counted_nonnegative'
      ) THEN
        ALTER TABLE public.stock_count_lines DROP CONSTRAINT stock_count_lines_counted_nonnegative;
      END IF;
    END $$;`);
  } finally {
    await releaseMigrationClient(client);
  }
}

test("posted and cancelled negatives upgrade cleanly, keep their values, and stay marked", async () => {
  const org = await createScratchOrg();
  try {
    await resetToPre0299();
    await receiveTen(org);
    const postedId = await openCount(org);
    await plantNegative(org.orgId, postedId);
    await setCountStatus(org.orgId, postedId, "posted");
    const cancelledId = await openCount(org);
    await plantNegative(org.orgId, cancelledId);
    await setCountStatus(org.orgId, cancelledId, "cancelled");

    await clearProbeLedger();
    await runStagedFile();

    // Both legacy rows survive with their values intact: nothing zeroed.
    const kept = await db.execute<{ countId: string; counted: string; marked: boolean }>(sql`
      select stock_count_id as "countId", counted_quantity::text as counted, is_pre_guard_legacy as marked
        from stock_count_lines
       where org_id = ${org.orgId} and stock_count_id in (${postedId}, ${cancelledId})
    `);
    assert.equal(kept.rows.length, 2);
    for (const row of kept.rows) {
      assert.equal(row.counted, "-1.0000", "the observed value is preserved as evidence");
      assert.equal(row.marked, true, "the legacy row is marked");
    }

    // The guard is validated and exempts only marked rows.
    const guard = await db.execute<{ validated: boolean; definition: string }>(sql`
      select convalidated as validated, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid = 'public.stock_count_lines'::regclass
         and conname = 'stock_count_lines_counted_nonnegative'
    `);
    assert.equal(guard.rows.length, 1);
    assert.equal(guard.rows[0]!.validated, true, "the staged guard ends validated");
    assert.match(guard.rows[0]!.definition, /OR is_pre_guard_legacy/);

    // A new negative still violates the guard under its historic name.
    const freshId = await openCount(org);
    const lineId = (await db.execute<{ id: string }>(sql`
      select id from stock_count_lines
       where org_id = ${org.orgId} and stock_count_id = ${freshId}
    `)).rows[0]!.id;
    await assert.rejects(
      db.execute(sql`
        update stock_count_lines set counted_quantity = '-2'
         where org_id = ${org.orgId} and id = ${lineId}
      `),
      (error: unknown) => {
        const cause = (error as { cause?: unknown }).cause as Error | undefined;
        assert.match(
          String(cause?.message ?? error),
          /stock_count_lines_counted_nonnegative/i,
        );
        return true;
      },
      "a new negative still violates the guard under its historic name",
    );

    // m74's 0326 predicate (posted status plus a negative observation)
    // selects exactly the posted row for upgrade_legacy_provenance.
    const provenance = await db.execute<{ lineId: string }>(sql`
      select l.id as "lineId"
        from stock_count_lines l
        join stock_counts c on c.org_id = l.org_id and c.id = l.stock_count_id
       where l.org_id = ${org.orgId} and c.status = 'posted'
         and l.counted_quantity is not null and l.counted_quantity < 0
    `);
    assert.equal(provenance.rows.length, 1, "the posted negative is the provenance selection");
  } finally {
    await clearProbeLedger().catch(() => {});
    await dropScratchOrg(org.orgId);
  }
});

test("open negatives refuse with the re-record remedy and mark nothing", async () => {
  const org = await createScratchOrg();
  try {
    await resetToPre0299();
    await receiveTen(org);
    const countId = await openCount(org);
    await plantNegative(org.orgId, countId);

    await clearProbeLedger();
    await assert.rejects(runStagedFile(), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /negative counted_quantity/);
      assert.match(message, /re-record the true physical count/);
      return true;
    });

    const marks = await db.execute<{ marked: string }>(sql`
      select count(*)::text as marked from stock_count_lines
       where org_id = ${org.orgId} and stock_count_id = ${countId} and is_pre_guard_legacy
    `);
    assert.equal(marks.rows[0]!.marked, "0", "a refused upgrade marks nothing");
  } finally {
    await clearProbeLedger().catch(() => {});
    await dropScratchOrg(org.orgId);
  }
});
