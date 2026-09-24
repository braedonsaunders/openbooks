import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { releaseStaleSandboxClaims, tick } from "./sandbox-scheduler.ts";

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

async function seedShell(
  productionOrgId: string,
  patch: { status?: string; lastError?: string | null; updatedAgoSec?: number },
): Promise<{ sandboxId: string; orgId: string }> {
  const orgId = randomUUID();
  const sandboxId = randomUUID();
  await db.execute(sql`
    insert into orgs (id, name, base_currency, country, env_kind, sandbox_of, sandbox_seed)
    values (${orgId}, 'stale claim shell', 'USD', 'US', 'sandbox', ${productionOrgId}, ${randomUUID()})
  `);
  await db.execute(sql`
    insert into sandboxes
      (id, org_id, production_org_id, name, tier, masked, status, refresh_schedule,
       refresh_keep_customizations, last_error, created_at, updated_at)
    values (${sandboxId}, ${orgId}, ${productionOrgId}, 'stale claim shell', 'dev', false, ${patch.status ?? "refreshing"},
            'daily', false, ${patch.lastError ?? null},
            now() - make_interval(secs => 7200),
            now() - make_interval(secs => ${patch.updatedAgoSec ?? 7200}))
  `);
  return { sandboxId, orgId };
}

test("a stale unproven refreshing claim returns to ready for re-queue", { skip: !DB }, async () => {
  // E08: an accepted-then-lost Redis job strands a sandbox in 'refreshing'.
  // Release only stale claims without worker proof; preserve fresh/proven work.
  const org = await withBypass(() => createScratchOrg());
  const shells: string[] = [];
  try {
    const stale = await seedShell(org.orgId, {});
    const proven = await seedShell(org.orgId, { lastError: "clone-rls-proof:7f3a" });
    const fresh = await seedShell(org.orgId, { updatedAgoSec: 60 });
    shells.push(stale.orgId, proven.orgId, fresh.orgId);

    assert.equal(await releaseStaleSandboxClaims(), 1);
    assert.deepEqual(await sandboxState(stale.sandboxId), {
      status: "ready",
      last_error: "refresh worker never started: stale scheduler claim released for re-queue",
    });
    assert.equal((await sandboxState(proven.sandboxId)).status, "refreshing");
    assert.equal((await sandboxState(fresh.sandboxId)).status, "refreshing");
  } finally {
    for (const shellOrgId of shells) {
      await db.execute(sql`delete from sandboxes where org_id = ${shellOrgId}`).catch(() => undefined);
      await db.execute(sql`delete from orgs where id = ${shellOrgId}`).catch(() => undefined);
    }
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

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
