import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg, withBypassContext } from "./db.ts";
import { actorHasPermission } from "./actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "./actor-subsidiaries.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

test("engine authorization separates home identity from active-organization grants", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const home = await createScratchOrg();
  const target = await createScratchOrg();
  try {
    const actor = await createScratchUser(home.orgId, "Cross-org administrator", "admin");
    await db.execute(sql`update users set is_super_admin=true where id=${actor}`);
    await withOrg(home.orgId, async () => {
      await db.execute(sql`update users set is_active=false where id=${actor}`);
      assert.equal(await actorHasPermission(db, home.orgId, actor, "gl.post"), false);
      await db.execute(sql`update users set is_active=true where id=${actor}`);
    });
    await withOrg(target.orgId, async () => {
      assert.equal(await actorHasPermission(db, target.orgId, actor, "gl.post"), true);
      assert.equal(await withBypassContext(() => actorAllowedSubsidiaryIds(db, target.orgId, actor)), null);
    });
    await db.execute(sql`update users set is_super_admin=false where id=${actor}`);
    assert.equal(await actorHasPermission(db, target.orgId, actor, "gl.post"), false);
    const local = await createScratchUser(target.orgId, "Target role owner", "poster");
    await db.execute(sql`update app_roles set permissions='["gl.post"]'::jsonb where org_id=${target.orgId} and key='poster'`);
    await db.execute(sql`insert into role_assignments (org_id,user_id,role_id)
      select ${target.orgId},${actor},role_id from role_assignments where user_id=${local} and org_id=${target.orgId}`);
    await withOrg(target.orgId, async () => {
      assert.equal(await actorHasPermission(db, target.orgId, actor, "gl.post"), true);
      assert.equal(await actorHasPermission(db, target.orgId, actor, "documents.manage"), false);
    });
    await db.execute(sql`update users set is_active=false where id=${actor}`);
    assert.equal(await actorHasPermission(db, target.orgId, actor, "gl.post"), false);
    assert.deepEqual(await withBypassContext(() => actorAllowedSubsidiaryIds(db, target.orgId, actor)), new Set());
  } finally {
    await dropScratchOrg(target.orgId);
    await dropScratchOrg(home.orgId);
  }
});
