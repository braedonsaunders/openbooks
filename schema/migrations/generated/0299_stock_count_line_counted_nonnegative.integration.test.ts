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
 * test replays the real migration bytes (read from the .sql file). 0299 is
 * transactional, so the downgrade, the planted history and the replay run
 * on one client inside a transaction that always rolls back: whatever the
 * test asserts, the shared catalog is untouched. The teardown then asserts
 * the table still matches its pre-test snapshot — a mismatch fails loudly,
 * so a refusal path that raises before rebuilding the guard can never
 * silently poison the files after it in the process order.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";
import {
  connectMigrationClient,
  executeMigrationBody,
  releaseMigrationClient,
  sanitizeMigrationContent,
} from "../../../scripts/bootstrap-migration-client.ts";
import { createStockCount } from "../../../engine/src/inventory/stock-counts.ts";
import { receiveInventory } from "../../../engine/src/inventory/movements.ts";
import {
  assertTableCatalogMatches,
  snapshotTableCatalog,
  withCatalogRollback,
  type CatalogQuery,
  type TableCatalogSnapshot,
} from "../../../engine/src/testing/migration-catalog.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";

const MIGRATION_FILENAME = "generated/0299_stock_count_line_counted_nonnegative.sql";

const migrationSql = readFileSync(
  new URL("./0299_stock_count_line_counted_nonnegative.sql", import.meta.url),
  "utf8",
);

async function catalogQuery(text: string): Promise<Array<Record<string, unknown>>> {
  const client = await connectMigrationClient();
  try {
    return (await client.query(text)).rows as Array<Record<string, unknown>>;
  } finally {
    await releaseMigrationClient(client);
  }
}

const snapshotQuery: CatalogQuery = (text) => catalogQuery(text);

let catalogBefore: TableCatalogSnapshot | null = null;

beforeEach(async () => {
  catalogBefore = await snapshotTableCatalog(snapshotQuery, "public.stock_count_lines");
});

afterEach(async () => {
  assert.ok(catalogBefore, "the pre-test catalog snapshot is missing");
  await assertTableCatalogMatches(
    snapshotQuery,
    catalogBefore,
    "0299 replay test must leave stock_count_lines exactly as found",
  );
});

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

test("posted and cancelled negatives upgrade cleanly, keep their values, and stay marked", async () => {
  const org = await createScratchOrg();
  const rollback = await connectMigrationClient();
  try {
    await receiveTen(org);
    const postedId = await openCount(org);
    const cancelledId = await openCount(org);
    // Opened outside the rollback transaction: the engine writes on its own
    // pool connection, which an uncommitted downgrade would block.
    const freshId = await openCount(org);
    await withCatalogRollback(rollback, async () => {
      await rollback.query(`DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'public.stock_count_lines'::regclass
             AND conname = 'stock_count_lines_counted_nonnegative'
        ) THEN
          ALTER TABLE public.stock_count_lines DROP CONSTRAINT stock_count_lines_counted_nonnegative;
        END IF;
      END $$;`);
      // A negative observation written past the engine preflight exactly as
      // the historical bug left it — on the rollback client, so the replay
      // below sees it inside the same transaction.
      await rollback.query(
        "update stock_count_lines set counted_quantity = '-1' where org_id = $1 and stock_count_id = $2",
        [org.orgId, postedId],
      );
      await rollback.query(
        "update stock_count_lines set counted_quantity = '-1' where org_id = $1 and stock_count_id = $2",
        [org.orgId, cancelledId],
      );
      await rollback.query("update stock_counts set status = $1 where org_id = $2 and id = $3", [
        "posted",
        org.orgId,
        postedId,
      ]);
      await rollback.query("update stock_counts set status = $1 where org_id = $2 and id = $3", [
        "cancelled",
        org.orgId,
        cancelledId,
      ]);

      await executeMigrationBody(rollback, sanitizeMigrationContent(migrationSql), {
        transactional: false,
        filename: MIGRATION_FILENAME,
      });

      // Both legacy rows survive with their values intact: nothing zeroed.
      const keptResult = await rollback.query(
        `select stock_count_id as "countId", counted_quantity::text as counted,
                is_pre_guard_legacy as marked
           from stock_count_lines
          where org_id = $1 and stock_count_id in ($2, $3)`,
        [org.orgId, postedId, cancelledId],
      );
      const kept = keptResult.rows as unknown as {
        countId: string;
        counted: string;
        marked: boolean;
      }[];
      assert.equal(kept.length, 2);
      for (const row of kept) {
        assert.equal(row.counted, "-1.0000", "the observed value is preserved as evidence");
        assert.equal(row.marked, true, "the legacy row is marked");
      }

      // The guard is validated and exempts only marked rows.
      const guardResult = await rollback.query(
        `select convalidated as validated, pg_get_constraintdef(oid) as definition
           from pg_constraint
          where conrelid = 'public.stock_count_lines'::regclass
            and conname = 'stock_count_lines_counted_nonnegative'`,
      );
      const guard = guardResult.rows as unknown as {
        validated: boolean;
        definition: string;
      }[];
      assert.equal(guard.length, 1);
      assert.equal(guard[0]!.validated, true, "the staged guard ends validated");
      assert.match(guard[0]!.definition, /OR is_pre_guard_legacy/);

      // m74's 0326 predicate (posted status plus a negative observation)
      // selects exactly the posted row for upgrade_legacy_provenance.
      const provenanceResult = await rollback.query(
        `select l.id as "lineId"
           from stock_count_lines l
           join stock_counts c on c.org_id = l.org_id and c.id = l.stock_count_id
          where l.org_id = $1 and c.status = 'posted'
            and l.counted_quantity is not null and l.counted_quantity < 0`,
        [org.orgId],
      );
      const provenance = provenanceResult.rows as unknown as { lineId: string }[];
      assert.equal(provenance.length, 1, "the posted negative is the provenance selection");

      // A new negative still violates the guard under its historic name.
      // Last: the refused UPDATE aborts the transaction, so nothing may
      // follow it on this client before the rollback.
      const lineResult = await rollback.query(
        `select id from stock_count_lines where org_id = $1 and stock_count_id = $2`,
        [org.orgId, freshId],
      );
      const lineId = (lineResult.rows as unknown as { id: string }[])[0]!.id;
      await assert.rejects(
        rollback.query(
          "update stock_count_lines set counted_quantity = '-2' where org_id = $1 and id = $2",
          [org.orgId, lineId],
        ),
        (error: unknown) => {
          assert.match(
            String((error as Error)?.message ?? error),
            /stock_count_lines_counted_nonnegative/i,
          );
          return true;
        },
        "a new negative still violates the guard under its historic name",
      );
    });
  } finally {
    await releaseMigrationClient(rollback);
    await dropScratchOrg(org.orgId);
  }
});

test("open negatives refuse with the re-record remedy and mark nothing", async () => {
  const org = await createScratchOrg();
  const rollback = await connectMigrationClient();
  try {
    await receiveTen(org);
    const countId = await openCount(org);
    await withCatalogRollback(rollback, async () => {
      await rollback.query(`DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'public.stock_count_lines'::regclass
             AND conname = 'stock_count_lines_counted_nonnegative'
        ) THEN
          ALTER TABLE public.stock_count_lines DROP CONSTRAINT stock_count_lines_counted_nonnegative;
        END IF;
      END $$;`);
      await rollback.query(
        "update stock_count_lines set counted_quantity = '-1' where org_id = $1 and stock_count_id = $2",
        [org.orgId, countId],
      );

      // The refused replay aborts the transaction, so recover to a
      // savepoint before asserting: the plant is still present, nothing is
      // marked, and the outer rollback still wipes every trace.
      await rollback.query("savepoint g54_refused_replay");
      await assert.rejects(
        executeMigrationBody(rollback, sanitizeMigrationContent(migrationSql), {
          transactional: false,
          filename: MIGRATION_FILENAME,
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /negative counted_quantity/);
          assert.match(message, /re-record the true physical count/);
          return true;
        },
      );
      await rollback.query("rollback to savepoint g54_refused_replay");

      const marksResult = await rollback.query(
        `select count(*)::text as marked from stock_count_lines
          where org_id = $1 and stock_count_id = $2 and is_pre_guard_legacy`,
        [org.orgId, countId],
      );
      const marks = marksResult.rows as unknown as { marked: string }[];
      assert.equal(marks[0]!.marked, "0", "a refused upgrade marks nothing");
    });
  } finally {
    await releaseMigrationClient(rollback);
    await dropScratchOrg(org.orgId);
  }
});
