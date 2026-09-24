import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "server-only") return { format: "module", source: "", shortCircuit: true, url: "data:text/javascript,export {}" };
    return nextResolve(specifier);
  },
});

const { db, env, withBypass } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { lockSuperAdminActor } = await import("./super-admin.ts");
const { sql } = await import("drizzle-orm");

test("a privileged write rechecks super-admin status after waiting for concurrent revocation", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  let unlockHolder!: () => void;
  let signalHolderLocked!: () => void;
  const releaseHolder = new Promise<void>((resolve) => { unlockHolder = resolve; });
  const holderLocked = new Promise<void>((resolve) => { signalHolderLocked = resolve; });
  try {
    const actorId = await createScratchUser(org.orgId, "Platform admin race", "admin");
    await withBypass(() => db.execute(sql`update users set is_super_admin = true, is_active = true where id = ${actorId}`));

    const revoker = withBypass(async () => {
      await db.execute(sql`select id from users where id = ${actorId} for update`);
      signalHolderLocked();
      await releaseHolder;
      await db.execute(sql`update users set is_super_admin = false where id = ${actorId}`);
    });
    await holderLocked;

    const privilegedWrite = withBypass(() => lockSuperAdminActor(db, actorId));
    const deadline = Date.now() + 5_000;
    let waiting = false;
    while (Date.now() < deadline) {
      waiting = (await withBypass(() => db.execute<{ waiting: boolean }>(sql`
        select exists (
          select 1 from pg_stat_activity
           where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
             and query ilike '%is_super_admin as "isSuperAdmin"%'
        ) as waiting
      `))).rows[0]?.waiting === true;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(waiting, "the protected write must block on the actor row before checking authority");

    unlockHolder();
    await revoker;
    await assert.rejects(privilegedWrite, /Platform super-admin access was revoked/u);
    const state = (await withBypass(() => db.execute<{ isSuperAdmin: boolean }>(sql`
      select is_super_admin as "isSuperAdmin" from users where id = ${actorId}
    `))).rows[0];
    assert.equal(state?.isSuperAdmin, false, "the stale authorization cannot pass after revocation commits");
  } finally {
    unlockHolder();
    await dropScratchOrg(org.orgId);
  }
});
