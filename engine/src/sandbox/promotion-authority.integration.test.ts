import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import {
  createScratchOrg,
  createScratchUser,
  grantScratchPermissions,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";
import { applyChangeSet, buildChangeSet, reviewChangeSet } from "./promote.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const manager = ["admin.sandboxes.manage", "admin.roles.manage"];
for (const scenario of [
  "no sandbox authority",
  "no role authority",
  "outside ceiling",
  "wildcard grant",
  "deny override",
  "within ceiling",
  "remove higher grant",
  "super admin",
  "invalid key",
  "restricted subsidiary scope",
] as const) {
  test(`role promotion authority: ${scenario}`, enabled, async () => {
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const actors: string[] = [];
      for (const name of ["Creator", "Reviewer", "Approver"])
        actors.push(await createScratchUser(org.orgId, name, "admin"));
      const applier = await createScratchUser(org.orgId, "Applying manager", "manager");
      await db.execute(
        sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`,
      );
      const held =
        scenario === "no sandbox authority"
          ? ["admin.roles.manage"]
          : scenario === "no role authority"
            ? ["admin.sandboxes.manage"]
            : scenario === "within ceiling"
              ? [...manager, "gl.post"]
              : scenario === "deny override"
                ? ["*"]
                : manager;
      await db.execute(
        sql`update app_roles set permissions=${JSON.stringify(held)}::jsonb where org_id=${org.orgId} and key='manager'`,
      );
      if (scenario === "restricted subsidiary scope") {
        await db.execute(
          sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='manager'`,
        );
      }
      if (scenario === "deny override")
        await db.execute(
          sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${applier},'gl.post','deny')`,
        );
      if (scenario === "super admin")
        await db.execute(
          sql`update users set is_super_admin=true where org_id=${org.orgId} and id=${applier}`,
        );
      // The removal case exercises a different assigned role above the manager's
      // ceiling; narrowing it must remain possible without minting new grants.
      if (scenario === "remove higher grant" || scenario === "within ceiling") {
        await createScratchUser(org.orgId, "Posting user", "target");
        await db.execute(
          sql`update app_roles set permissions=${JSON.stringify(scenario === "within ceiling" ? ["gl.read"] : ["gl.post", "gl.read"])}::jsonb where org_id=${org.orgId} and key='target'`,
        );
      }
      const key =
        scenario === "remove higher grant" || scenario === "within ceiling" ? "target" : "manager";
      const before = (
        await db.execute<{ permissions: string[] }>(
          sql`select permissions from app_roles where org_id=${org.orgId} and key=${key}`,
          "objects",
        )
      )[0]!.permissions;
      sandbox = await createSandbox({
        productionOrgId: org.orgId,
        name: "Promotion authority",
        tier: "full",
        masked: false,
      });
      const requested =
        scenario === "remove higher grant"
          ? ["gl.read"]
          : scenario === "within ceiling"
            ? ["gl.read", "gl.post"]
            : scenario === "wildcard grant"
              ? ["*"]
              : scenario === "invalid key"
                ? [...manager, "gl.imaginary"]
                : [...manager, "gl.post"];
      await db.execute(
        sql`update app_roles set permissions=${JSON.stringify(requested)}::jsonb,name=name||' promoted' where org_id=${sandbox.sandboxOrgId} and key=${key}`,
      );
      const change = await buildChangeSet(sandbox.sandboxId, "Role authority test", actors[0]);
      await reviewChangeSet(change.changeSetId, actors[1]);
      const allowed = ["within ceiling", "remove higher grant", "super admin"].includes(scenario);
      if (allowed) {
        await applyChangeSet(change.changeSetId, applier);
        assert.deepEqual(
          (
            await db.execute(
              sql`select permissions from app_roles where org_id=${org.orgId} and key=${key}`,
              "objects",
            )
          )[0]!.permissions,
          [...new Set(requested)],
        );
      } else {
        const expected =
          scenario === "no sandbox authority"
            ? /requires admin.sandboxes.manage/
            : scenario === "no role authority"
              ? /requires admin.roles.manage/
              : scenario === "restricted subsidiary scope"
                ? /requires unrestricted subsidiary access/
                : scenario === "invalid key"
                  ? /valid permission keys/
                  : /cannot grant permissions you do not hold/;
        await assert.rejects(applyChangeSet(change.changeSetId, applier), expected);
        assert.deepEqual(
          (
            await db.execute(
              sql`select permissions from app_roles where org_id=${org.orgId} and key=${key}`,
              "objects",
            )
          )[0]!.permissions,
          before,
        );
        assert.equal(
          (
            await db.execute(
              sql`select status from change_sets where org_id=${org.orgId} and id=${change.changeSetId}`,
              "objects",
            )
          )[0]!.status,
          "approved",
        );
        assert.equal(await actorHasPermission(db, org.orgId, applier, "gl.post"), false);
      }
    } finally {
      if (sandbox) await deleteSandbox(sandbox.sandboxId);
      await dropScratchOrgReporting(org.orgId);
    }
  });
}

test("role promotion checks the actor's raw subsidiary grant coverage", enabled, async () => {
  const org = await createScratchOrg();
  const creator = await createScratchUser(org.orgId, "Scope creator", "admin");
  const reviewer = await createScratchUser(org.orgId, "Scope reviewer", "admin");
  const approver = await createScratchUser(org.orgId, "Scope approver", "admin");
  const applier = await createScratchUser(org.orgId, "Scope applier", "manager");
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
  try {
    for (const actorId of [creator, reviewer, approver]) {
      await grantScratchPermissions(org.orgId, actorId, ["admin.sandboxes.manage"]);
    }
    await db.execute(sql`update app_roles set permissions=${JSON.stringify(manager)}::jsonb,
      subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [] })}::jsonb
      where org_id=${org.orgId} and key='manager'`);
    sandbox = await createSandbox({
      productionOrgId: org.orgId,
      name: "Role grant coverage",
      tier: "full",
      masked: false,
    });
    const sandboxRoot = (
      await db.execute<{ id: string }>(
        sql`
      select id from subsidiaries where org_id=${sandbox.sandboxOrgId} and parent_id is null`,
        "objects",
      )
    )[0]!.id;
    await db.execute(sql`
      update app_roles set subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [sandboxRoot] })}::jsonb
       where org_id=${sandbox.sandboxOrgId} and key='manager'`);
    const change = await buildChangeSet(sandbox.sandboxId, "Role grant coverage", creator);
    await reviewChangeSet(change.changeSetId, reviewer);

    // A second, unrestricted role lets the actor pass the effective-scope
    // check, but malformed stored scope evidence must still fail the raw
    // delegation-coverage check at apply time.
    const allRole = (
      await db.execute<{ id: string }>(
        sql`
      insert into app_roles (org_id, key, name, is_built_in, permissions, subsidiary_restriction)
      values (${org.orgId}, 'scope_all', 'Scope all', false, '[]'::jsonb, '{"mode":"all"}'::jsonb)
      returning id`,
        "objects",
      )
    )[0]!.id;
    const unknownRole = (
      await db.execute<{ id: string }>(
        sql`
      insert into app_roles (org_id, key, name, is_built_in, permissions, subsidiary_restriction)
      values (${org.orgId}, 'scope_unknown', 'Scope unknown', false, '[]'::jsonb, '{"mode":"unknown"}'::jsonb)
      returning id`,
        "objects",
      )
    )[0]!.id;
    await db.execute(sql`
      insert into role_assignments (org_id, user_id, role_id)
      values (${org.orgId}, ${applier}, ${allRole}), (${org.orgId}, ${applier}, ${unknownRole})`);

    await assert.rejects(
      applyChangeSet(change.changeSetId, applier),
      /cannot grant subsidiary access beyond your scope/,
    );
    assert.deepEqual(
      (
        await db.execute(
          sql`select subsidiary_restriction from app_roles where org_id=${org.orgId} and key='manager'`,
          "objects",
        )
      )[0]!.subsidiary_restriction,
      { mode: "list", subsidiaryIds: [] },
    );
  } finally {
    if (sandbox) await deleteSandbox(sandbox.sandboxId);
    await dropScratchOrgReporting(org.orgId);
  }
});
