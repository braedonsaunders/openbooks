import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../engine/src/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../engine/src/test-fixtures.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

async function seed() {
  const org = await createScratchOrg();
  const userId = await createScratchUser(org.orgId, "Guard target", "guard_target");
  const otherUserId = await createScratchUser(org.orgId, "Guard other", "guard_other");
  const firstRole = (await db.execute<{ id: string }>(sql`select id from app_roles
    where org_id = ${org.orgId} and key = 'guard_target'`)).rows[0]!.id;
  const extraRole = (await db.execute<{ id: string }>(sql`insert into app_roles(org_id, key, name, permissions)
    values (${org.orgId}, 'guard_extra', 'Extra', '[]'::jsonb) returning id`)).rows[0]!.id;
  return { orgId: org.orgId, userId, otherUserId, firstRole, extraRole };
}

function code(error: unknown): string | undefined {
  const value = error as { code?: string; cause?: { code?: string } };
  return value.cause?.code ?? value.code;
}

for (const isolation of ["read committed", "repeatable read"] as const) {
  test(`database guard rejects concurrent removal of every role (${isolation})`, { skip }, async () => {
    const f = await seed();
    const first = await pool.connect();
    const second = await pool.connect();
    const gate = await pool.connect();
    const trigger = `zz_role_guard_${randomUUID().replaceAll("-", "")}`;
    const pending: Promise<unknown>[] = [];
    let installed = false;
    try {
      await db.execute(sql`insert into role_assignments(org_id, user_id, role_id) values (${f.orgId}, ${f.userId}, ${f.extraRole})`);
      // Force an unlocked guard to let both commits reach this barrier. A
      // locking guard serializes them or rejects a deadlock/stale snapshot.
      await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$ begin
        if OLD.org_id = '${f.orgId}'::uuid and OLD.user_id = '${f.userId}'::uuid then
          perform pg_advisory_xact_lock(hashtextextended('${trigger}' || OLD.role_id::text, 0));
        end if; return NULL; end $$`));
      await db.execute(sql.raw(`create constraint trigger ${trigger} after delete on role_assignments
        deferrable initially deferred for each row execute function ${trigger}()`));
      installed = true;
      await gate.query("begin");
      await gate.query("select pg_advisory_xact_lock(hashtextextended($1, 0)), pg_advisory_xact_lock(hashtextextended($2, 0))", [trigger + f.firstRole, trigger + f.extraRole]);
      const pid = (await gate.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      await Promise.all([first, second].map(async (client, index) => {
        await client.query(`begin isolation level ${isolation}`);
        await client.query("select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)", [f.orgId]);
        await client.query("delete from role_assignments where org_id = $1 and user_id = $2 and role_id = $3", [f.orgId, f.userId, index === 0 ? f.firstRole : f.extraRole]);
      }));
      let settled = 0;
      pending.push(first.query("commit"), second.query("commit"));
      for (const operation of pending) void operation.then(() => { settled++; }, () => { settled++; });
      let reached = false;
      for (let attempt = 0; attempt < 600; attempt++) {
        const result = await pool.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))", [pid]);
        const blocked = result.rows[0]!.n;
        if (blocked >= 2 || (blocked >= 1 && settled >= 1)) { reached = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(reached, "commits reached the controlled post-guard barrier");
      await gate.query("commit");
      const results = await Promise.allSettled(pending);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.ok(["23514", "40P01", "40001"].includes(code(rejected.reason) ?? ""));
      const assignments = await db.execute(sql`select id from role_assignments where org_id = ${f.orgId} and user_id = ${f.userId}`);
      assert.equal(assignments.rows.length, 1);
      const active = await db.execute(sql`select is_active from users where org_id = ${f.orgId} and id = ${f.userId}`);
      assert.equal(active.rows[0]!.is_active, true);
    } finally {
      await gate.query("rollback"); gate.release();
      await Promise.allSettled(pending);
      await first.query("rollback"); first.release();
      await second.query("rollback"); second.release();
      if (installed) await db.execute(sql.raw(`drop trigger ${trigger} on role_assignments`));
      await db.execute(sql.raw(`drop function if exists ${trigger}()`));
      await dropScratchOrg(f.orgId);
    }
  });
}

test("moving an assignment cannot strand its former active user, and controlled replacements remain valid", { skip }, async () => {
  const f = await seed();
  try {
    const snapshot = async () => (await db.execute(sql`select * from role_assignments where org_id = ${f.orgId} order by id`)).rows;
    const before = await snapshot();
    await assert.rejects(db.transaction(async (tx) => {
      await tx.execute(sql`update role_assignments set user_id = ${f.otherUserId}
        where org_id = ${f.orgId} and user_id = ${f.userId}`);
    }), (error) => code(error) === "23514");
    assert.deepEqual(await snapshot(), before);
    await db.transaction(async (tx) => {
      await tx.execute(sql`insert into role_assignments(org_id, user_id, role_id) values (${f.orgId}, ${f.userId}, ${f.extraRole})`);
      await tx.execute(sql`update role_assignments set user_id = ${f.otherUserId}
        where org_id = ${f.orgId} and user_id = ${f.userId} and role_id = ${f.firstRole}`);
    });
    const remaining = await db.execute<{ role_id: string }>(sql`select role_id from role_assignments where org_id = ${f.orgId} and user_id = ${f.userId}`);
    assert.deepEqual(remaining.rows.map((row) => row.role_id), [f.extraRole]);
    // Ordinary metadata updates do not fire a removal check or change access.
    await db.execute(sql`update role_assignments set updated_at = now() where org_id = ${f.orgId} and user_id = ${f.userId}`);
    await db.transaction(async (tx) => {
      await tx.execute(sql`update users set is_active = false where org_id = ${f.orgId} and id = ${f.userId}`);
      await tx.execute(sql`delete from role_assignments where org_id = ${f.orgId} and user_id = ${f.userId}`);
    });
    await assert.rejects(db.execute(sql`update users set is_active = true where org_id = ${f.orgId} and id = ${f.userId}`), (error) => code(error) === "23514");
    await db.transaction(async (tx) => {
      await tx.execute(sql`insert into role_assignments(org_id, user_id, role_id) values (${f.orgId}, ${f.userId}, ${f.extraRole})`);
      await tx.execute(sql`update users set is_active = true where org_id = ${f.orgId} and id = ${f.userId}`);
    });
  } finally { await dropScratchOrg(f.orgId); }
});
