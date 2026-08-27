import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  orgRowCounts,
} from "./test-fixtures.ts";
import { createSandbox, deleteSandbox } from "./sandbox/lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Drizzle wraps driver errors (DrizzleQueryError), hiding the PostgreSQL
 * message in `cause`; match the whole rendered chain so a trigger rejection
 * stays assertable. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

const migration = readFileSync(
  new URL(
    "../../schema/migrations/generated/0043_sandbox_wip_prebill_wipe_guard.sql",
    import.meta.url,
  ),
  "utf8",
);

const deployedWipGuard = `
CREATE OR REPLACE FUNCTION public.wip_prebill_event_append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('openbooks.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION 'WIP prebill events are append-only';
END $$;
`;

test("0043 scopes the deployed WIP guard and replays safely", { skip: !DB }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(deployedWipGuard);
    const before = await client.query<{ definition: string }>(
      "select pg_get_functiondef('public.wip_prebill_event_append_only_guard()'::regprocedure) as definition",
    );
    assert.match(before.rows[0]!.definition, /current_setting\('openbooks\.sandbox_wipe'/);

    await client.query(migration);
    await client.query(migration);
    const after = await client.query<{ definition: string }>(
      "select pg_get_functiondef('public.wip_prebill_event_append_only_guard()'::regprocedure) as definition",
    );
    assert.match(after.rows[0]!.definition, /openbooks_sandbox_wipe_allowed\(old\.org_id\)/i);
    assert.doesNotMatch(after.rows[0]!.definition, /current_setting\(/);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
});

test("a fresh-schema sandbox wipe fully clears WIP pre-bill events", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `WIP wipe ${randomUUID()}`;
  let sandboxId: string | null = null;
  let sandboxOrgId: string | null = null;
  try {
    const projectId = randomUUID();
    const prebillId = randomUUID();
    const eventId = randomUUID();
    await db.execute(sql`
      insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values
        (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'WIP-WIPE',
         'WIP wipe regression', ${org.customerId}, 'active', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into wip_prebills
        (id, org_id, project_id, worksheet_number, period_end)
      values
        (${prebillId}, ${org.orgId}, ${projectId}, 'WIP-WIPE-1', ${org.date})`);
    await db.execute(sql`
      insert into wip_prebill_events
        (id, org_id, prebill_id, event_type, actor_id)
      values
        (${eventId}, ${org.orgId}, ${prebillId}, 'created', ${randomUUID()})`);

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.sandbox_wipe', 'on', true)`);
        await tx.execute(sql`
          delete from wip_prebill_events
           where org_id = ${org.orgId} and id = ${eventId}`);
      }),
      (error: unknown) => pgMessage(error).includes("WIP prebill events are append-only"),
    );
    const preserved = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from wip_prebill_events
       where org_id = ${org.orgId} and id = ${eventId}`);
    assert.equal(Number(preserved.rows[0]!.count), 1);

    const sandbox = await createSandbox({
      productionOrgId: org.orgId,
      name: sandboxName,
      tier: "full",
      masked: false,
    });
    sandboxId = sandbox.sandboxId;
    sandboxOrgId = sandbox.sandboxOrgId;
    const planted = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from wip_prebill_events
       where org_id = ${sandboxOrgId}`);
    assert.equal(Number(planted.rows[0]!.count), 1);

    await deleteSandbox(sandboxId);
    sandboxId = null;
    assert.deepEqual(await orgRowCounts(sandboxOrgId), {});
  } finally {
    if (sandboxId) {
      await deleteSandbox(sandboxId).catch(() => undefined);
    } else {
      const failed = await db.execute<{ id: string }>(sql`
        select id
          from sandboxes
         where production_org_id = ${org.orgId} and name = ${sandboxName}`);
      for (const row of failed.rows) await deleteSandbox(row.id).catch(() => undefined);
    }
    await dropScratchOrgReporting(org.orgId);
  }
});
