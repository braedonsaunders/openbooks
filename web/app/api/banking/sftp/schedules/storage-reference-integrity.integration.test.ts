import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

/**
 * Storage half of SFTP import-schedule reference integrity.
 *
 * The schedule list and the import scan join both parents by (org_id, id),
 * so storage pins each parent with a composite (org_id, id) foreign key: raw
 * writes cannot save a schedule naming another organization's (or a missing)
 * server or account, and a parent that still feeds a schedule refuses to
 * delete instead of orphaning it, while unreferenced parents delete normally.
 */

const { db, withBypass } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");

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

test("both parents are pinned by composite tenant foreign keys", async () => {
  const rows = await withBypass(() =>
    db.execute<{ conname: string; def: string }>(
      sql`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.sftp_import_schedules'::regclass
         and contype = 'f'
         and conname = any(${sql.param([SERVER_FKEY, ACCOUNT_FKEY])}::text[])
       order by conname`,
      "objects",
    ),
  );
  assert.deepEqual(
    rows.map((row) => [row.conname, row.def.replace(/REFERENCES public\./, "REFERENCES ")]),
    [
      [ACCOUNT_FKEY, "FOREIGN KEY (org_id, account_id) REFERENCES accounts(org_id, id) DEFERRABLE"],
      [
        SERVER_FKEY,
        "FOREIGN KEY (org_id, sftp_server_id) REFERENCES sftp_servers(org_id, id) DEFERRABLE",
      ],
    ],
  );
});

test("raw SQL cannot save a schedule naming a foreign or missing server", async () => {
  const fixture = await seed();
  const other = await seed();
  try {
    // Cross-tenant server: a realistic second row, so the failure proves
    // tenant coherence rather than mere existence.
    await assert.rejects(
      insertSchedule(fixture.orgId, other.serverId, fixture.bankAccountId, fixture.actorId),
      (e: unknown) => errorCode(e) === "23503" && errorText(e).includes(SERVER_FKEY),
      "a foreign-organization server must fail closed at the storage layer",
    );
    await assert.rejects(
      insertSchedule(fixture.orgId, randomUUID(), fixture.bankAccountId, fixture.actorId),
      (e: unknown) => errorCode(e) === "23503" && errorText(e).includes(SERVER_FKEY),
      "an unknown server must fail closed at the storage layer",
    );
    const leftovers = await withBypass(() =>
      db.execute<{ n: number }>(
        sql`select count(*)::int as n from sftp_import_schedules where org_id = ${fixture.orgId}`,
        "objects",
      ),
    );
    assert.equal(Number(leftovers[0]!.n), 0);
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
    await withBypass(() => dropScratchOrg(other.orgId));
  }
});

test("raw SQL cannot save a schedule naming a foreign or missing account", async () => {
  const fixture = await seed();
  const other = await seed();
  try {
    await assert.rejects(
      insertSchedule(fixture.orgId, fixture.serverId, other.bankAccountId, fixture.actorId),
      (e: unknown) => errorCode(e) === "23503" && errorText(e).includes(ACCOUNT_FKEY),
      "a foreign-organization account must fail closed at the storage layer",
    );
    await assert.rejects(
      insertSchedule(fixture.orgId, fixture.serverId, randomUUID(), fixture.actorId),
      (e: unknown) => errorCode(e) === "23503" && errorText(e).includes(ACCOUNT_FKEY),
      "an unknown account must fail closed at the storage layer",
    );
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
    await withBypass(() => dropScratchOrg(other.orgId));
  }
});

test("a referenced server cannot delete (no orphan); unreferenced deletes work", async () => {
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
      db.execute<{ sftp_server_id: string }>(
        sql`select sftp_server_id from sftp_import_schedules where id = ${scheduleId}`,
        "objects",
      ),
    );
    assert.equal(
      schedule[0]?.sftp_server_id,
      fixture.serverId,
      "the refused delete must leave the schedule untouched",
    );
    // Normal lifecycle still works: schedule first, then its server.
    await withBypass(async () => {
      await db.execute(sql`delete from sftp_import_schedules where id = ${scheduleId}`);
      await db.execute(
        sql`delete from sftp_servers where id = ${fixture.serverId} and org_id = ${fixture.orgId}`,
      );
    });
    const gone = await withBypass(() =>
      db.execute(sql`select 1 from sftp_servers where id = ${fixture.serverId}`, "objects"),
    );
    assert.equal(gone.length, 0);
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
  }
});
