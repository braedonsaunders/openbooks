import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../engine/src/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../engine/src/test-fixtures.ts";

const skip = !process.env.OPENBOOKS_DB_URL;
const cases = ["missing_user", "missing_role", "cross_org_user", "cross_org_role", "missing_assignment_org", "missing_role_org", "delete_referenced_role"] as const;

for (const kind of cases) {
  test(`identity references refuse ${kind}`, { skip }, async () => {
    const a = await createScratchOrg();
    const b = await createScratchOrg();
    const client = await pool.connect();
    try {
      const userA = await createScratchUser(a.orgId, "Reference A", "reference_a");
      const userB = await createScratchUser(b.orgId, "Reference B", "reference_b");
      const roleA = (await db.execute<{ id: string }>(sql`select id from app_roles where org_id = ${a.orgId} and key = 'reference_a'`)).rows[0]!.id;
      const roleB = (await db.execute<{ id: string }>(sql`select id from app_roles where org_id = ${b.orgId} and key = 'reference_b'`)).rows[0]!.id;
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      let statement = "insert into role_assignments(org_id, user_id, role_id) values ($1, $2, $3)";
      let values: string[];
      switch (kind) {
        case "missing_user": values = [a.orgId, randomUUID(), roleA]; break;
        case "missing_role": values = [a.orgId, userA, randomUUID()]; break;
        case "cross_org_user": values = [a.orgId, userB, roleA]; break;
        case "cross_org_role": values = [a.orgId, userA, roleB]; break;
        case "missing_assignment_org": values = [randomUUID(), userA, roleA]; break;
        case "missing_role_org":
          statement = "insert into app_roles(org_id, key, name) values ($1, 'orphan_role', 'Orphan')";
          values = [randomUUID()]; break;
        case "delete_referenced_role": statement = "delete from app_roles where id = $1"; values = [roleA]; break;
      }
      await assert.rejects(client.query(statement, values), (error: unknown) => (error as { code?: string }).code === "23503");
      await client.query("rollback");
      const assignments = await db.execute<{ role_id: string }>(sql`select role_id from role_assignments where org_id = ${a.orgId} and user_id = ${userA}`);
      assert.deepEqual(assignments.rows.map((row) => row.role_id), [roleA]);
    } finally {
      await client.query("rollback"); client.release();
      await dropScratchOrg(a.orgId); await dropScratchOrg(b.orgId);
    }
  });
}

test("valid role references support explicit replacement and inactive-user deletion", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Reference lifecycle", "reference_lifecycle");
    const original = (await db.execute<{ id: string }>(sql`select id from app_roles where org_id = ${org.orgId} and key = 'reference_lifecycle'`)).rows[0]!.id;
    const replacement = (await db.execute<{ id: string }>(sql`insert into app_roles(org_id, key, name, permissions)
      values (${org.orgId}, 'replacement', 'Replacement', '[]'::jsonb) returning id`)).rows[0]!.id;
    await db.transaction(async (tx) => {
      await tx.execute(sql`insert into role_assignments(org_id, user_id, role_id) values (${org.orgId}, ${userId}, ${replacement})`);
      await tx.execute(sql`delete from role_assignments where org_id = ${org.orgId} and user_id = ${userId} and role_id = ${original}`);
      await tx.execute(sql`delete from app_roles where org_id = ${org.orgId} and id = ${original}`);
    });
    assert.equal((await db.execute(sql`select id from role_assignments where org_id = ${org.orgId} and user_id = ${userId} and role_id = ${replacement}`)).rows.length, 1);
    await db.execute(sql`update users set is_active = false where org_id = ${org.orgId} and id = ${userId}`);
    await db.execute(sql`delete from users where org_id = ${org.orgId} and id = ${userId}`);
    assert.equal((await db.execute(sql`select id from role_assignments where org_id = ${org.orgId} and user_id = ${userId}`)).rows.length, 0);
  } finally { await dropScratchOrg(org.orgId); }
});
