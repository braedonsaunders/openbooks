import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { actorHasPermission } from "../actor-permissions.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../test-fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";
import { applyChangeSet, approveChangeSet, buildChangeSet, reviewChangeSet } from "./promote.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const manager = ["admin.sandboxes.manage", "admin.roles.manage"];
for (const scenario of ["no sandbox authority", "no role authority", "outside ceiling", "wildcard grant", "deny override", "within ceiling", "remove higher grant", "super admin", "invalid key"] as const) {
  test(`role promotion authority: ${scenario}`, enabled, async () => {
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const actors: string[] = [];
      for (const name of ["Creator", "Reviewer", "Approver"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
      const applier = await createScratchUser(org.orgId, "Applying manager", "manager");
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      const held = scenario === "no sandbox authority" ? ["admin.roles.manage"]
        : scenario === "no role authority" ? ["admin.sandboxes.manage"]
        : scenario === "within ceiling" ? [...manager, "gl.post"]
        : scenario === "deny override" ? ["*"] : manager;
      await db.execute(sql`update app_roles set permissions=${JSON.stringify(held)}::jsonb where org_id=${org.orgId} and key='manager'`);
      if (scenario === "deny override") await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${applier},'gl.post','deny')`);
      if (scenario === "super admin") await db.execute(sql`update users set is_super_admin=true where org_id=${org.orgId} and id=${applier}`);
      // The removal case exercises a different assigned role above the manager's
      // ceiling; narrowing it must remain possible without minting new grants.
      if (scenario === "remove higher grant" || scenario === "within ceiling") {
        await createScratchUser(org.orgId, "Posting user", "target");
        await db.execute(sql`update app_roles set permissions=${JSON.stringify(scenario === "within ceiling" ? ["gl.read"] : ["gl.post", "gl.read"])}::jsonb where org_id=${org.orgId} and key='target'`);
      }
      const key = scenario === "remove higher grant" || scenario === "within ceiling" ? "target" : "manager";
      const before = (await db.execute<{ permissions: string[] }>(sql`select permissions from app_roles where org_id=${org.orgId} and key=${key}`)).rows[0]!.permissions;
      sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Promotion authority", tier: "full", masked: false });
      const requested = scenario === "remove higher grant" ? ["gl.read"]
        : scenario === "within ceiling" ? ["gl.read", "gl.post"]
        : scenario === "wildcard grant" ? ["*"]
        : scenario === "invalid key" ? [...manager, "gl.imaginary"] : [...manager, "gl.post"];
      await db.execute(sql`update app_roles set permissions=${JSON.stringify(requested)}::jsonb,name=name||' promoted' where org_id=${sandbox.sandboxOrgId} and key=${key}`);
      const change = await buildChangeSet(sandbox.sandboxId, "Role authority test", actors[0]);
      await reviewChangeSet(change.changeSetId, actors[1]);
      await approveChangeSet(change.changeSetId, actors[2]);
      const allowed = ["within ceiling", "remove higher grant", "super admin"].includes(scenario);
      if (allowed) {
        await applyChangeSet(change.changeSetId, applier);
        assert.deepEqual((await db.execute(sql`select permissions from app_roles where org_id=${org.orgId} and key=${key}`)).rows[0]!.permissions, [...new Set(requested)]);
      } else {
        const expected = scenario === "no sandbox authority" ? /requires admin.sandboxes.manage/
          : scenario === "no role authority" ? /requires admin.roles.manage/
          : scenario === "invalid key" ? /valid permission keys/ : /cannot grant permissions you do not hold/;
        await assert.rejects(applyChangeSet(change.changeSetId, applier), expected);
        assert.deepEqual((await db.execute(sql`select permissions from app_roles where org_id=${org.orgId} and key=${key}`)).rows[0]!.permissions, before);
        assert.equal((await db.execute(sql`select status from change_sets where org_id=${org.orgId} and id=${change.changeSetId}`)).rows[0]!.status, "approved");
        assert.equal(await actorHasPermission(db, org.orgId, applier, "gl.post"), false);
      }
    } finally {
      if (sandbox) await deleteSandbox(sandbox.sandboxId);
      await dropScratchOrgReporting(org.orgId);
    }
  });
}
