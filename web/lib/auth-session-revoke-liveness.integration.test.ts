import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });

async function seedSessions(orgId: string) {
  return withBypassContext(async () => {
    const userId = (await seedFlowActors(orgId)).adminId;
    const caller = randomUUID();
    const others = [randomUUID(), randomUUID()];
    for (const id of [caller, ...others]) await db.execute(sql`
      insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at)
      values (${id},${userId},${randomBytes(32).toString("hex")},'password',${new Date(Date.now() + 86_400_000)})`);
    return { userId, caller, others };
  });
}

async function revokedById(orgId: string, userId: string) {
  return withOrgContext(orgId, async () => (await db.execute<{ id: string; revoked: boolean }>(sql`
    select id, (revoked_at is not null) as revoked from auth_sessions where user_id=${userId} order by id`)).rows);
}

test("revokeOtherUserSessions refuses when the keeper session was revoked first", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  try {
    const auth = await import("./auth");
    const { userId, caller, others } = await seedSessions(org.orgId);
    await withBypassContext(async () => {
      await db.execute(sql`update auth_sessions set revoked_at=now(), revocation_reason='user_revoked' where id=${caller}`);
    });
    assert.deepEqual(await auth.revokeOtherUserSessions(userId, caller), {
      ok: false, reason: "caller_session_revoked",
    });
    for (const row of await revokedById(org.orgId, userId)) {
      assert.equal(row.revoked, row.id === caller, `only the pre-revoked keeper may be revoked: ${row.id}`);
    }
    assert.ok(others.length === 2);
  } finally {
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("revokeOtherUserSessions revokes the others for a live keeper", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  try {
    const auth = await import("./auth");
    const { userId, caller, others } = await seedSessions(org.orgId);
    assert.deepEqual(await auth.revokeOtherUserSessions(userId, caller), { ok: true, revoked: others.length });
    const rows = await revokedById(org.orgId, userId);
    assert.equal(rows.find((row) => row.id === caller)?.revoked, false);
    for (const id of others) assert.equal(rows.find((row) => row.id === id)?.revoked, true);
  } finally {
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("revokeUserSession refuses a dead caller without touching the target", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  try {
    const auth = await import("./auth");
    const { userId, caller, others } = await seedSessions(org.orgId);
    await withBypassContext(async () => {
      await db.execute(sql`update auth_sessions set revoked_at=now(), revocation_reason='user_revoked' where id=${caller}`);
    });
    assert.deepEqual(await auth.revokeUserSession(userId, others[0]!, caller), {
      ok: false, reason: "caller_session_revoked",
    });
    assert.equal((await revokedById(org.orgId, userId)).find((row) => row.id === others[0])?.revoked, false);
  } finally {
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("revokeUserSession revokes another session and its own for a live caller", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  try {
    const auth = await import("./auth");
    const { userId, caller, others } = await seedSessions(org.orgId);
    assert.deepEqual(await auth.revokeUserSession(userId, others[0]!, caller), { ok: true, revoked: true });
    assert.deepEqual(await auth.revokeUserSession(userId, randomUUID(), caller), { ok: true, revoked: false });
    assert.deepEqual(await auth.revokeUserSession(userId, caller, caller), { ok: true, revoked: true });
  } finally {
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("revokeOtherUserSessions refuses a keeper revoked while it waited on the lock", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  let release = () => {};
  let held: Promise<unknown> | undefined;
  let contender: Promise<import("./auth").RevokeSessionsResult> | undefined;
  try {
    const auth = await import("./auth");
    const { userId, caller, others } = await seedSessions(org.orgId);
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let holderPid = 0;
    held = withBypass(async () => {
      holderPid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      await db.execute(sql`update auth_sessions set revoked_at=now(), revocation_reason='user_revoked' where id=${caller}`);
      await hold;
    });
    const deadline = Date.now() + 10_000;
    while ((await withBypassContext(async () => (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity where datname=current_database() and pid=${holderPid} and state <> 'idle'
    `)).rows[0]!.n)) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    contender = auth.revokeOtherUserSessions(userId, caller);
    let settled = false;
    void contender.then(() => { settled = true; }, () => { settled = true; });
    const blockDeadline = Date.now() + 10_000;
    let blocked = false;
    while (!settled && Date.now() < blockDeadline) {
      blocked = await withBypassContext(async () => (await db.execute<{ blocked: boolean }>(sql`select exists(
        select 1 from pg_stat_activity where datname=current_database()
          and ${holderPid}=any(pg_blocking_pids(pid))
      ) as blocked`)).rows[0]!.blocked);
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "revocation must reach the held keeper lock before revoking");
    release();
    await held;
    assert.deepEqual(await contender, { ok: false, reason: "caller_session_revoked" });
    assert.equal(others.length, 2);
    for (const id of others) {
      assert.equal((await revokedById(org.orgId, userId)).find((row) => row.id === id)?.revoked, false);
    }
  } finally {
    release();
    await Promise.allSettled([held, contender]);
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
