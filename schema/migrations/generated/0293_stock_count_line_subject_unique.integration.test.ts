/**
 * 0293 stages the duplicate-subject guard as a concurrent build (U10) while
 * preserving posted history it can no longer refuse (U13).
 *
 * A populated install may hold duplicate subjects on posted or cancelled
 * counts — immutable lines the engine refuses to edit and counts it refuses
 * to cancel, with no delete path — so "merge each group into one line" is
 * not an executable remedy for them. The staged file marks those rows
 * is_pre_guard_legacy and enforces uniqueness only over unmarked rows;
 * duplicates on counts still open for correction refuse with the
 * cancel-and-recount remedy. New duplicates stay refused under the same
 * index name.
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently. Each
 * test replays the real migration bytes (read from the .sql file) through
 * the real attempt executor under a probe ledger name: the body is
 * idempotent, so replaying it on an already-migrated database is exactly
 * what a runner retry does.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

const PROBE_FILENAME = "generated/0999_g43_0293_probe.sql";
const PROBE_DIGEST = "g43-0293-probe";

const migrationSql = readFileSync(
  new URL("./0293_stock_count_line_subject_unique.sql", import.meta.url),
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

/** A second line for the count's own subject, written past the engine
 * preflight exactly as the historical bug left it. */
async function plantDuplicateLine(orgId: string, countId: string): Promise<void> {
  await db.execute(sql`
    insert into stock_count_lines
      (id, org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity)
    select ${randomUUID()}, ${orgId}, ${countId}, item_id, stock_location_id, lot_id, expected_quantity
      from stock_count_lines
     where org_id = ${orgId} and stock_count_id = ${countId}
     limit 1
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
      transactional: false,
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

/** Return the guard to its pre-0293 state (no constraint, no index) so the
 * test proves the staged build from scratch on any database — a fresh
 * install, which never had the guard, or an old install, whose full
 * constraint the restamp leaves untouched. Dropping the old full constraint
 * takes only a brief lock and scans nothing. */
async function resetToPre0293(): Promise<void> {
  const client = await connectMigrationClient();
  try {
    await client.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.stock_count_lines'::regclass
           AND conname = 'stock_count_lines_no_duplicate_subject'
      ) THEN
        ALTER TABLE public.stock_count_lines DROP CONSTRAINT stock_count_lines_no_duplicate_subject;
      END IF;
    END $$;`);
    await client.query("DROP INDEX IF EXISTS stock_count_lines_no_duplicate_subject");
  } finally {
    await releaseMigrationClient(client);
  }
}

test("posted and cancelled duplicates upgrade cleanly, keep provenance, and stay marked", async () => {
  const org = await createScratchOrg();
  try {
    await resetToPre0293();
    await receiveTen(org);
    const postedId = await openCount(org);
    await plantDuplicateLine(org.orgId, postedId);
    await setCountStatus(org.orgId, postedId, "posted");
    const cancelledId = await openCount(org);
    await plantDuplicateLine(org.orgId, cancelledId);
    await setCountStatus(org.orgId, cancelledId, "cancelled");

    await clearProbeLedger();
    await runStagedFile();

    // Both legacy pairs survive with their full history: nothing deleted,
    // nothing merged, both lines of each pair marked.
    const marked = await db.execute<{ countId: string; marked: number; total: number }>(sql`
      select stock_count_id as "countId",
             count(*) filter (where is_pre_guard_legacy)::int as marked,
             count(*)::int as total
        from stock_count_lines
       where org_id = ${org.orgId} and stock_count_id in (${postedId}, ${cancelledId})
       group by stock_count_id
    `);
    assert.equal(marked.rows.length, 2);
    for (const row of marked.rows) {
      assert.equal(row.total, 2, "both duplicate lines survive");
      assert.equal(row.marked, 2, "both lines of the legacy pair are marked");
    }

    // The guard is a valid partial unique index under the same name.
    const guard = await db.execute<{ valid: boolean; definition: string }>(sql`
      select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
        from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = 'stock_count_lines_no_duplicate_subject'
    `);
    assert.equal(guard.rows.length, 1);
    assert.equal(guard.rows[0]!.valid, true);
    assert.match(guard.rows[0]!.definition, /WHERE \(NOT is_pre_guard_legacy\)/);
    assert.match(guard.rows[0]!.definition, /NULLS NOT DISTINCT/);

    // New data stays fully guarded: a duplicate on an open count collides
    // with the index under its historic name. (Marked legacy rows are out
    // of the index by design — only the engine creation preflight, which
    // refuses every duplicate before it reaches storage, guards those
    // subjects for new writes, and a posted count cannot post again.)
    const freshId = await openCount(org);
    // The index name lives on the driver's cause, not the drizzle wrapper
    // message (same shape the lifecycle suite asserts).
    await assert.rejects(
      plantDuplicateLine(org.orgId, freshId),
      (error: unknown) => {
        const cause = (error as { cause?: unknown }).cause as Error | undefined;
        assert.match(
          String(cause?.message ?? error),
          /stock_count_lines_no_duplicate_subject/i,
        );
        return true;
      },
      "a new duplicate still violates the guard under its historic name",
    );

    // m74's 0326 predicate (posted status plus a duplicate sibling) selects
    // exactly the posted pair for upgrade_legacy_provenance.
    const provenance = await db.execute<{ lineId: string }>(sql`
      select l.id as "lineId"
        from stock_count_lines l
        join stock_counts c on c.org_id = l.org_id and c.id = l.stock_count_id
       where l.org_id = ${org.orgId} and c.status = 'posted'
         and exists (
           select 1 from stock_count_lines s
            where s.org_id = l.org_id and s.stock_count_id = l.stock_count_id
              and s.item_id = l.item_id and s.stock_location_id = l.stock_location_id
              and s.lot_id is not distinct from l.lot_id and s.id <> l.id
         )
    `);
    assert.equal(provenance.rows.length, 2, "the posted pair is the provenance selection");
  } finally {
    await clearProbeLedger().catch(() => {});
    await dropScratchOrg(org.orgId);
  }
});

test("open duplicates refuse with the cancel-and-recount remedy and mark nothing", async () => {
  const org = await createScratchOrg();
  try {
    await resetToPre0293();
    await receiveTen(org);
    const countId = await openCount(org);
    await plantDuplicateLine(org.orgId, countId);

    await clearProbeLedger();
    await assert.rejects(runStagedFile(), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /open duplicate/);
      assert.match(message, /cancel the count/);
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

test("an INVALID index left by a failed build is dropped and rebuilt valid", async () => {
  const org = await createScratchOrg();
  try {
    await resetToPre0293();
    await receiveTen(org);
    await openCount(org);
    const setup = await connectMigrationClient();
    try {
      await setup.query("drop index if exists stock_count_lines_no_duplicate_subject");
      const failed = await setup
        .query(
          "CREATE INDEX CONCURRENTLY stock_count_lines_no_duplicate_subject "
            + "ON stock_count_lines ((item_id::text::int))",
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      assert.ok(failed, "the poisoned build must fail");
      const invalid = await setup.query<{ valid: boolean }>(
        `select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
          where c.relname = 'stock_count_lines_no_duplicate_subject'`,
      );
      assert.equal(invalid.rows.length, 1);
      assert.equal(invalid.rows[0]!.valid, false);
    } finally {
      await releaseMigrationClient(setup);
    }

    await clearProbeLedger();
    await runStagedFile();

    const healed = await db.execute<{ valid: boolean; definition: string }>(sql`
      select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
        from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = 'stock_count_lines_no_duplicate_subject'
    `);
    assert.equal(healed.rows.length, 1);
    assert.equal(healed.rows[0]!.valid, true);
    assert.match(healed.rows[0]!.definition, /\(org_id, stock_count_id, item_id, stock_location_id, lot_id\)/);
  } finally {
    // Best-effort reheal: this test drops the shared guard index, so a
    // failure above must not leave later files without the guard.
    await clearProbeLedger().catch(() => {});
    await runStagedFile().catch(() => {});
    await clearProbeLedger().catch(() => {});
    await dropScratchOrg(org.orgId);
  }
});

const REAL_FILENAME = "generated/0293_stock_count_line_subject_unique.sql";
const OLD_DIGEST = "19b0e9b674360129aec13cb3c911de38dfd1cb86f1976cca3979c28521720c11";

const migration0299Sql = readFileSync(
  new URL("./0299_stock_count_line_counted_nonnegative.sql", import.meta.url),
  "utf8",
);

test("an install recorded at the old digest reapplies to the fresh catalog", async () => {
  // Downgrade to the old published state: the full unique constraint, the
  // old CHECK without the exemption, no marker column, ledger at the old
  // digest. The 0299 CHECK goes first — its staged form references the
  // marker, so it holds the column.
  const setup = await connectMigrationClient();
  try {
    // The governed view selects the marker once a refresh has seen it; drop
    // it first so the column can return to its pre-guard absence, exactly as
    // on an install recorded at the old digest. The staged file's trailing
    // refresh rebuilds it.
    await setup.query("DROP VIEW IF EXISTS openbooks_query.stock_count_lines");
    await setup.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.stock_count_lines'::regclass
           AND conname = 'stock_count_lines_counted_nonnegative'
      ) THEN
        ALTER TABLE public.stock_count_lines DROP CONSTRAINT stock_count_lines_counted_nonnegative;
      END IF;
    END $$;`);
    await setup.query("DROP INDEX IF EXISTS stock_count_lines_no_duplicate_subject");
    await setup.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.stock_count_lines'::regclass
           AND conname = 'stock_count_lines_no_duplicate_subject'
      ) THEN
        ALTER TABLE public.stock_count_lines DROP CONSTRAINT stock_count_lines_no_duplicate_subject;
      END IF;
    END $$;`);
    await setup.query("ALTER TABLE public.stock_count_lines DROP COLUMN IF EXISTS is_pre_guard_legacy");
    await setup.query(
      `ALTER TABLE public.stock_count_lines
         ADD CONSTRAINT stock_count_lines_no_duplicate_subject
         UNIQUE NULLS NOT DISTINCT (org_id, stock_count_id, item_id, stock_location_id, lot_id)`,
    );
    await setup.query(
      `ALTER TABLE public.stock_count_lines
         ADD CONSTRAINT stock_count_lines_counted_nonnegative
         CHECK (counted_quantity IS NULL OR counted_quantity >= 0)`,
    );
    await setup.query("update public._applied_migrations set sha256 = $2 where filename = $1", [
      REAL_FILENAME,
      OLD_DIGEST,
    ]);
    const freshDigest = createHash("sha256").update(migrationSql).digest("hex");

    // The reapply: exactly the call applyTracked makes for a recorded
    // digest — body plus the guarded ledger advance.
    const reapply = await connectMigrationClient();
    try {
      await executeMigrationAttempt(reapply, {
        filename: REAL_FILENAME,
        body: sanitizeMigrationContent(migrationSql),
        transactional: false,
        lock: migrationLockConfig({}),
        digest: freshDigest,
        recordedDigest: OLD_DIGEST,
        executeBody: (migrationClient, body, step) =>
          executeMigrationBody(migrationClient, body, step),
      });
    } finally {
      await releaseMigrationClient(reapply);
    }

    // Ledger advanced to the fresh digest.
    const ledger = await setup.query<{ sha256: string }>(
      "select sha256 from public._applied_migrations where filename = $1",
      [REAL_FILENAME],
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0]!.sha256, freshDigest, "the reapply advances the ledger");

    // stock_count_lines matches a fresh install: the marker column, the
    // valid partial index, and no full constraint left behind.
    const column = await setup.query<{ name: string; nullable: boolean; hasDefault: boolean }>(
      `select attname as name, not attnotnull as nullable,
              atthasdef as "hasDefault"
         from pg_attribute
         join pg_class on pg_class.oid = attrelid
         join pg_namespace on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public' and relname = 'stock_count_lines'
          and attname = 'is_pre_guard_legacy'`,
    );
    assert.equal(column.rows.length, 1, "the reapply gains the marker column");
    assert.equal(column.rows[0]!.nullable, false);
    assert.equal(column.rows[0]!.hasDefault, true);
    const guard = await setup.query<{ valid: boolean; definition: string }>(
      `select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = 'stock_count_lines_no_duplicate_subject'`,
    );
    assert.equal(guard.rows.length, 1);
    assert.equal(guard.rows[0]!.valid, true);
    assert.match(guard.rows[0]!.definition, /WHERE \(NOT is_pre_guard_legacy\)/);
    const leftover = await setup.query<{ n: string }>(
      `select count(*)::text as n from pg_constraint
        where conrelid = 'public.stock_count_lines'::regclass
          and conname = 'stock_count_lines_no_duplicate_subject'`,
    );
    assert.equal(leftover.rows[0]!.n, "0", "no full constraint survives the reapply");
    const viewdef = await setup.query<{ definition: string }>(
      "select pg_get_viewdef('openbooks_query.stock_count_lines'::regclass) as definition",
    );
    assert.match(viewdef.rows[0]!.definition, /is_pre_guard_legacy/, "the reapply converges the governed view");
  } finally {
    // Best-effort view rebuild for failure windows, then restore the 0299
    // staged CHECK through its own idempotent body under a probe ledger
    // name; the real 0299 ledger row is untouched.
    const restore = await connectMigrationClient();
    try {
      await restore.query("SELECT public.openbooks_refresh_query_catalog()").catch(() => {});
      await executeMigrationAttempt(restore, {
        filename: "generated/0999_g43_0299_probe.sql",
        body: sanitizeMigrationContent(migration0299Sql),
        transactional: true,
        lock: migrationLockConfig({}),
        digest: "g43-0299-restore",
        executeBody: (migrationClient, body, step) =>
          executeMigrationBody(migrationClient, body, step),
      }).catch(() => {});
      await restore.query("delete from public._applied_migrations where filename = $1", [
        "generated/0999_g43_0299_probe.sql",
      ]).catch(() => {});
    } finally {
      await releaseMigrationClient(restore);
    }
    await releaseMigrationClient(setup);
  }
});
