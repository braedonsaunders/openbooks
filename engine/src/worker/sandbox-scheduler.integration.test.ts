import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { releaseStaleSandboxClaims } from "./sandbox-scheduler.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

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

async function sandboxState(
  sandboxId: string,
): Promise<{ status: string; lastError: string | null }> {
  const row = (await db.execute<{ status: string; lastError: string | null }>(sql`
    select status, last_error as "lastError" from sandboxes where id = ${sandboxId}
  `)).rows[0]!;
  return { status: row.status, lastError: row.lastError };
}

test("a stale unproven refreshing claim returns to ready for re-queue", { skip: !DB }, async () => {
  // E08: the tick flips ready→refreshing before the Redis enqueue, so an
  // accepted-then-lost job strands the sandbox in 'refreshing' forever (the
  // tick selects only 'ready'). The reaper must release it with a named
  // note; proven and fresh claims must be left alone.
  const org = await withBypass(() => createScratchOrg());
  const shells: string[] = [];
  try {
    const stale = await seedShell(org.orgId, {});
    const proven = await seedShell(org.orgId, { lastError: "clone-rls-proof:7f3a" });
    const fresh = await seedShell(org.orgId, { updatedAgoSec: 60 });
    shells.push(stale.orgId, proven.orgId, fresh.orgId);

    const released = await releaseStaleSandboxClaims();
    assert.equal(released, 1, "exactly the stale unproven claim is released");

    assert.deepEqual(await sandboxState(stale.sandboxId), {
      status: "ready",
      lastError: "refresh worker never started: stale scheduler claim released for re-queue",
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
