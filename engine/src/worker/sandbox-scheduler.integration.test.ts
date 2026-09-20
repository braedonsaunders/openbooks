import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { tick } from "./sandbox-scheduler.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedDueSandbox(productionOrgId: string): Promise<{ sandboxId: string; sandboxOrgId: string }> {
  const sandboxOrgId = randomUUID();
  await db.execute(sql`
    insert into orgs (id, name, legal_name, base_currency, country, tax_ids, settings, env_kind, sandbox_of, sandbox_seed)
    values (${sandboxOrgId}, 'sched-test', 'sched-test', 'CAD', 'CA',
            '{}'::jsonb, '{}'::jsonb, 'sandbox', ${productionOrgId}, ${randomUUID()})`);
  const row = (await db.execute<{ id: string }>(sql`
    insert into sandboxes (org_id, production_org_id, name, tier, masked, status, refresh_schedule, last_refresh_at)
    values (${sandboxOrgId}, ${productionOrgId}, 'sched-test', 'masked', true,
            'ready', 'hourly', now() - interval '2 hours')
    returning id`)).rows[0]!;
  return { sandboxId: row.id, sandboxOrgId };
}

async function sandboxState(sandboxId: string): Promise<{ status: string; last_error: string | null }> {
  const res = (await db.execute<{ status: string; last_error: string | null }>(sql`
    select status, last_error from sandboxes where id = ${sandboxId}`));
  return res.rows[0]!;
}

test("a failed refresh enqueue releases the scheduler claim instead of wedging the sandbox", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const { sandboxId, sandboxOrgId } = await seedDueSandbox(org.orgId);
  try {
    const failingEnqueue = async (): Promise<never> => {
      throw new Error("redis unavailable");
    };
    await tick(failingEnqueue as unknown as Parameters<typeof tick>[0]);
    const state = await sandboxState(sandboxId);
    assert.equal(state.status, "ready");
    assert.match(state.last_error ?? "", /redis unavailable/);
  } finally {
    await db.execute(sql`delete from sandboxes where id = ${sandboxId}`);
    await db.execute(sql`delete from orgs where id = ${sandboxOrgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a successful tick still claims the sandbox and enqueues its refresh", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const { sandboxId, sandboxOrgId } = await seedDueSandbox(org.orgId);
  try {
    const calls: unknown[] = [];
    const recordingEnqueue = (async (data: unknown) => {
      calls.push(data);
      return undefined;
    }) as unknown as Parameters<typeof tick>[0];
    await tick(recordingEnqueue);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { op: string }).op, "refresh");
    assert.equal((calls[0] as { sandboxId: string }).sandboxId, sandboxId);
    const state = await sandboxState(sandboxId);
    assert.equal(state.status, "refreshing");
  } finally {
    await db.execute(sql`delete from sandboxes where id = ${sandboxId}`);
    await db.execute(sql`delete from orgs where id = ${sandboxOrgId}`);
    await dropScratchOrg(org.orgId);
  }
});
