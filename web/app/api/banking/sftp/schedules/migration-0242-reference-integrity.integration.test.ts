import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";

/**
 * F07 storage half: migration 0242_sftp_schedule_reference_integrity.
 *
 * The schedule list and the import scan join both parents by (org_id, id)
 * with no parent FKs in storage, so raw writes could save invisible
 * cross-tenant orphans that the route can no longer create. The migration
 * preflights legacy rows (refusing with a named remedy, never deleting or
 * rewriting them) and then pins both parents with composite
 * (org_id, id) FKs. Parent deletes keep refusing instead of orphaning,
 * while unreferenced parents still delete normally.
 *
 * Test-safety contract (not just runner configuration): every test that
 * touches DDL first validates the live target with the existing
 * fixture-safety machinery (`assertFixtureDatabase`, which refuses a
 * shared/non-ephemeral database by its catalog marker), and the one probe
 * that weakens storage runs entirely inside a single dedicated
 * transaction that always rolls back — constraint drops, staged orphans,
 * and the reapplied migration never escape it, even when an assertion
 * fails. No mocks: real SQL through the real database implementation.
 */

const { db, pool, withBypass } =
  await import("@openbooks/engine/src/platform/db.ts");
const {
  assertFixtureDatabase,
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} = await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

const MIGRATION_SQL = readFileSync(
  "schema/migrations/generated/0242_sftp_schedule_reference_integrity.sql",
  "utf8",
);

const SERVER_FKEY = "sftp_import_schedules_sftp_server_id_tenant_fkey";
const ACCOUNT_FKEY = "sftp_import_schedules_account_id_tenant_fkey";

function errorCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code ?? err?.cause?.code;
}

function errorText(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } };
  return `${err?.message ?? ""}\n${err?.cause?.message ?? ""}`;
}

/** Refuse a wrong target before ANY DDL in this file runs. */
async function requireEphemeralTarget(): Promise<void> {
  if (!DB) return;
  await assertFixtureDatabase();
}

/** Apply 0242 exactly as bootstrap would (single script, idempotent). */
async function applyMigration(): Promise<void> {
  await requireEphemeralTarget();
  await withBypass(async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
  });
}

async function constraintNames(): Promise<Set<string>> {
  return withBypass(async () => {
    const r = await db.execute<{ conname: string }>(sql`
      select conname from pg_constraint
       where conrelid = 'public.sftp_import_schedules'::regclass
         and contype = 'f'`);
    return new Set(r.rows.map((row) => row.conname));
  });
}

interface Fixture {
  orgId: string;
  actorId: string;
  bankAccountId: string;
  serverId: string;
}

async function seed(): Promise<Fixture> {
  return withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(
      org.orgId,
      "SFTP Storage Witness",
      "sftp_storage_witness",
    );
    const serverId = randomUUID();
    const name = `stor-parent-${randomUUID().slice(0, 8)}`;
    await db.execute(sql`
      insert into sftp_servers (id, org_id, name, username, root_prefix, created_by, updated_by)
      values (${serverId}, ${org.orgId}, ${name}, ${name}, ${`sftp/${org.orgId}/${name}`}, ${actorId}, ${actorId})`);
    return {
      orgId: org.orgId,
      actorId,
      bankAccountId: org.accounts.bank,
      serverId,
    };
  });
}

async function insertSchedule(
  orgId: string,
  serverId: string,
  accountId: string,
  actorId: string,
): Promise<string> {
  const id = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, created_by)
      values (${id}, ${orgId}, ${serverId}, ${accountId}, ${actorId})`);
  });
  return id;
}

test(
  "migration DDL refuses before touching storage when the runtime marker is wrong",
  { skip: !DB },
  async () => {
    const saved = process.env.OPENBOOKS_TEST_DB_MARKER;
    // Canonical shape but not this database's marker: the catalog check
    // must refuse, not the shape check.
    process.env.OPENBOOKS_TEST_DB_MARKER =
      "openbooks-ci-ephemeral-00000000-0000-0000-000000000000";
    try {
      await assert.rejects(
        applyMigration(),
        /refusing shared\/non-ephemeral database/,
        "DDL must refuse the wrong target before running",
      );
    } finally {
      if (saved === undefined) delete process.env.OPENBOOKS_TEST_DB_MARKER;
      else process.env.OPENBOOKS_TEST_DB_MARKER = saved;
    }
    // Nothing ran: both FKs are still installed.
    const names = await constraintNames();
    assert.ok(names.has(SERVER_FKEY));
    assert.ok(names.has(ACCOUNT_FKEY));
  },
);

test(
  "0242 applies cleanly, installs both composite FKs, and reapplies",
  { skip: !DB },
  async () => {
    await applyMigration();
    const names = await constraintNames();
    assert.ok(
      names.has(SERVER_FKEY),
      `expected ${SERVER_FKEY} in ${[...names].join(", ")}`,
    );
    assert.ok(
      names.has(ACCOUNT_FKEY),
      `expected ${ACCOUNT_FKEY} in ${[...names].join(", ")}`,
    );
    // Idempotent reapply (bootstrap-safe rerun).
    await applyMigration();
    const again = await constraintNames();
    assert.ok(again.has(SERVER_FKEY));
    assert.ok(again.has(ACCOUNT_FKEY));
  },
);

test(
  "raw SQL cannot save a schedule naming a foreign or missing server",
  { skip: !DB },
  async () => {
    await applyMigration();
    const fixture = await seed();
    const other = await seed();
    try {
      // Cross-tenant server: a REALISTIC second row, so the failure proves
      // tenant coherence rather than mere existence.
      await assert.rejects(
        insertSchedule(
          fixture.orgId,
          other.serverId,
          fixture.bankAccountId,
          fixture.actorId,
        ),
        (e: unknown) =>
          errorCode(e) === "23503" && errorText(e).includes(SERVER_FKEY),
        "a foreign-organization server must fail closed at the storage layer",
      );
      await assert.rejects(
        insertSchedule(
          fixture.orgId,
          randomUUID(),
          fixture.bankAccountId,
          fixture.actorId,
        ),
        (e: unknown) =>
          errorCode(e) === "23503" && errorText(e).includes(SERVER_FKEY),
        "an unknown server must fail closed at the storage layer",
      );
      const leftovers = await withBypass(() =>
        db.execute(
          sql`select count(*)::int as n from sftp_import_schedules where org_id = ${fixture.orgId}`,
        ),
      );
      assert.equal(Number(leftovers.rows[0]!.n), 0);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);

test(
  "raw SQL cannot save a schedule naming a foreign or missing account",
  { skip: !DB },
  async () => {
    await applyMigration();
    const fixture = await seed();
    const other = await seed();
    try {
      await assert.rejects(
        insertSchedule(
          fixture.orgId,
          fixture.serverId,
          other.bankAccountId,
          fixture.actorId,
        ),
        (e: unknown) =>
          errorCode(e) === "23503" && errorText(e).includes(ACCOUNT_FKEY),
        "a foreign-organization account must fail closed at the storage layer",
      );
      await assert.rejects(
        insertSchedule(
          fixture.orgId,
          fixture.serverId,
          randomUUID(),
          fixture.actorId,
        ),
        (e: unknown) =>
          errorCode(e) === "23503" && errorText(e).includes(ACCOUNT_FKEY),
        "an unknown account must fail closed at the storage layer",
      );
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);

interface PgRefusal {
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
}

/** The refusal must carry row evidence and a remedy in DETAIL/HINT — not
 * just a message, and not an echo of the submitted query. */
function assertPreflightRefusal(
  e: unknown,
  expected: {
    column: string;
    scheduleId: string;
    orgId: string;
    referenceId: string;
    referencedTable: string;
  },
): void {
  const err = e as PgRefusal;
  assert.equal(err.code, "23514");
  assert.match(
    err.message ?? "",
    new RegExp(
      `legacy data violates tenant coherence: public\\.sftp_import_schedules\\.${expected.column}`,
    ),
  );
  const detail = JSON.parse(err.detail ?? "") as Record<string, string>;
  assert.equal(detail.table, "sftp_import_schedules");
  assert.equal(detail.schedule_id, expected.scheduleId);
  assert.equal(detail.org_id, expected.orgId);
  assert.equal(detail.column, expected.column);
  assert.equal(detail.reference_id, expected.referenceId);
  assert.equal(detail.referenced_table, expected.referencedTable);
  assert.match(err.hint ?? "", /retry migration 0242/);
}

test(
  "0242 preflight refuses each legacy orphan path with row evidence and preserves rows",
  { skip: !DB },
  async () => {
    await requireEphemeralTarget();
    const fixture = await seed();
    const other = await seed();
    // One dedicated transaction for the whole probe: the constraint drops,
    // the staged orphans, and the reapplied migration all vanish in the
    // final rollback — even when an assertion above fails. Savepoints bound
    // each expected migration failure so the probe continues afterwards.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      await client.query(
        `ALTER TABLE public.sftp_import_schedules DROP CONSTRAINT IF EXISTS ${SERVER_FKEY}`,
      );
      await client.query(
        `ALTER TABLE public.sftp_import_schedules DROP CONSTRAINT IF EXISTS ${ACCOUNT_FKEY}`,
      );
      // Stage both legacy shapes beneath the dropped constraints: a
      // REALISTIC foreign server row and a REALISTIC foreign account row.
      const serverOrphanId = randomUUID();
      const accountOrphanId = randomUUID();
      await client.query(
        `insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, created_by)
         values ($1, $2, $3, $4, $5)`,
        [
          serverOrphanId,
          fixture.orgId,
          other.serverId,
          fixture.bankAccountId,
          fixture.actorId,
        ],
      );
      await client.query(
        `insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, created_by)
         values ($1, $2, $3, $4, $5)`,
        [
          accountOrphanId,
          fixture.orgId,
          fixture.serverId,
          other.bankAccountId,
          fixture.actorId,
        ],
      );

      await client.query("savepoint preflight_server");
      const serverErr = await client
        .query(MIGRATION_SQL)
        .then(
          () => null,
          (e: unknown) => e,
        );
      await client.query("rollback to savepoint preflight_server");
      assert.ok(serverErr, "the migration must refuse the foreign-server orphan");
      assertPreflightRefusal(serverErr, {
        column: "sftp_server_id",
        scheduleId: serverOrphanId,
        orgId: fixture.orgId,
        referenceId: other.serverId,
        referencedTable: "sftp_servers",
      });
      const keptServer = await client.query(
        `select sftp_server_id from sftp_import_schedules where id = $1`,
        [serverOrphanId],
      );
      assert.equal(
        keptServer.rows.length,
        1,
        "the refused migration must preserve the server orphan for the operator",
      );
      assert.equal(keptServer.rows[0]!.sftp_server_id, other.serverId);

      // Reconcile the server path; the account path must refuse next.
      await client.query(
        `delete from sftp_import_schedules where id = $1`,
        [serverOrphanId],
      );
      await client.query("savepoint preflight_account");
      const accountErr = await client
        .query(MIGRATION_SQL)
        .then(
          () => null,
          (e: unknown) => e,
        );
      await client.query("rollback to savepoint preflight_account");
      assert.ok(accountErr, "the migration must refuse the foreign-account orphan");
      assertPreflightRefusal(accountErr, {
        column: "account_id",
        scheduleId: accountOrphanId,
        orgId: fixture.orgId,
        referenceId: other.bankAccountId,
        referencedTable: "accounts",
      });
      const keptAccount = await client.query(
        `select account_id from sftp_import_schedules where id = $1`,
        [accountOrphanId],
      );
      assert.equal(
        keptAccount.rows.length,
        1,
        "the refused migration must preserve the account orphan for the operator",
      );
      assert.equal(keptAccount.rows[0]!.account_id, other.bankAccountId);

      // Fully reconciled, the migration lands inside the probe.
      await client.query(
        `delete from sftp_import_schedules where id = $1`,
        [accountOrphanId],
      );
      await client.query(MIGRATION_SQL);
      const names = await client.query(
        `select conname from pg_constraint
          where conrelid = 'public.sftp_import_schedules'::regclass and contype = 'f'`,
      );
      const installed = new Set(
        names.rows.map((row: { conname: string }) => row.conname),
      );
      assert.ok(installed.has(SERVER_FKEY));
      assert.ok(installed.has(ACCOUNT_FKEY));

      await client.query("rollback");
    } finally {
      // Belt and braces: the probe transaction never commits.
      await client.query("rollback").catch(() => undefined);
      client.release();
      await withBypass(() => dropScratchOrg(fixture.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);

test(
  "a referenced server cannot delete (no orphan); unreferenced deletes work",
  { skip: !DB },
  async () => {
    await applyMigration();
    const fixture = await seed();
    try {
      const scheduleId = await insertSchedule(
        fixture.orgId,
        fixture.serverId,
        fixture.bankAccountId,
        fixture.actorId,
      );
      await assert.rejects(
        withBypass(() =>
          db.execute(
            sql`delete from sftp_servers where id = ${fixture.serverId} and org_id = ${fixture.orgId}`,
          ),
        ),
        (e: unknown) => errorCode(e) === "23503",
        "deleting a server that still feeds a schedule must refuse",
      );
      const schedule = await withBypass(() =>
        db.execute(
          sql`select sftp_server_id from sftp_import_schedules where id = ${scheduleId}`,
        ),
      );
      assert.equal(
        schedule.rows[0]?.sftp_server_id,
        fixture.serverId,
        "the refused delete must leave the schedule untouched",
      );
      // Normal lifecycle still works: schedule first, then its server.
      await withBypass(async () => {
        await db.execute(
          sql`delete from sftp_import_schedules where id = ${scheduleId}`,
        );
        await db.execute(
          sql`delete from sftp_servers where id = ${fixture.serverId} and org_id = ${fixture.orgId}`,
        );
      });
      const gone = await withBypass(() =>
        db.execute(
          sql`select 1 from sftp_servers where id = ${fixture.serverId}`,
        ),
      );
      assert.equal(gone.rows.length, 0);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);
