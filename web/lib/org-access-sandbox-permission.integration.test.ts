import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { resolveActiveEnv, rebaseUuid } = await import("./org-access");

// ID4 — entering a sandbox is a privileged act (admin.sandboxes.manage), but
// the check lived only in the workspace-switcher UI. resolveActiveEnv is the
// one choke point both the enterOrg server action and currentUser()'s
// per-request re-resolution pass through, so enforcing it here also ejects a
// user whose permission is revoked while they hold a valid sandbox cookie.

interface Fixture {
  homeOrgId: string;
  sandboxOrgId: string;
  homeUserId: string;
  homeRoleId: string;
  sandboxUserId: string;
}

async function seed(): Promise<Fixture> {
  const home = await createScratchOrg();
  const sandbox = await createScratchOrg();
  const homeUserId = await createScratchUser(home.orgId, "Home member", "member");
  const homeRoleId = (await db.execute<{ id: string }>(sql`
    select id from app_roles where org_id = ${home.orgId} and key = 'member'`)).rows[0]!.id;
  await db.execute(sql`update orgs set env_kind = 'production' where id = ${home.orgId}`);
  await db.execute(sql`update orgs set env_kind = 'sandbox', sandbox_of = ${home.orgId} where id = ${sandbox.orgId}`);
  const seedValue = (await db.execute<{ seed: string }>(sql`
    select sandbox_seed::text as seed from orgs where id = ${sandbox.orgId}`)).rows[0]!.seed;
  const sandboxUserId = await createScratchUser(
    sandbox.orgId, "Cloned member", "member", rebaseUuid(homeUserId, seedValue) as `${string}-${string}-${string}-${string}-${string}`,
  );
  await db.execute(sql`
    insert into sandboxes (org_id, production_org_id, name, status)
    values (${sandbox.orgId}, ${home.orgId}, 'Permission review', 'ready')`);
  return { homeOrgId: home.orgId, sandboxOrgId: sandbox.orgId, homeUserId, homeRoleId, sandboxUserId };
}

async function setRolePermissions(roleId: string, permissions: string[]): Promise<void> {
  await db.execute(sql`update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb where id = ${roleId}`);
}

test("sandbox entry requires admin.sandboxes.manage in the production org", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    const home = { id: f.homeUserId, orgId: f.homeOrgId, isSuperAdmin: false };

    await setRolePermissions(f.homeRoleId, ["gl.read", "ap.*"]);
    assert.equal(await resolveActiveEnv(home, f.sandboxOrgId), null, "no permission: refused");

    await setRolePermissions(f.homeRoleId, ["gl.read", "admin.sandboxes.manage"]);
    const admitted = await resolveActiveEnv(home, f.sandboxOrgId);
    assert.equal(admitted?.orgId, f.sandboxOrgId);
    assert.equal(admitted?.actingUserId, f.sandboxUserId);
    assert.equal(admitted?.envKind, "sandbox");

    await setRolePermissions(f.homeRoleId, ["admin.*"]);
    assert.equal((await resolveActiveEnv(home, f.sandboxOrgId))?.actingUserId, f.sandboxUserId, "module wildcard covers it");

    // A deny override wins over the role grant — the live effective set is what counts.
    await setRolePermissions(f.homeRoleId, ["admin.sandboxes.manage"]);
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${f.homeOrgId}, ${f.homeUserId}, 'admin.sandboxes.manage', 'deny')`);
    assert.equal(await resolveActiveEnv(home, f.sandboxOrgId), null, "deny override: refused");
    await db.execute(sql`delete from user_permission_overrides where user_id = ${f.homeUserId}`);

    // A grant override alone admits.
    await setRolePermissions(f.homeRoleId, []);
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${f.homeOrgId}, ${f.homeUserId}, 'admin.sandboxes.manage', 'grant')`);
    assert.equal((await resolveActiveEnv(home, f.sandboxOrgId))?.actingUserId, f.sandboxUserId, "grant override admits");
    await db.execute(sql`delete from user_permission_overrides where user_id = ${f.homeUserId}`);

    // Revoking the permission evicts a user already inside (same resolver runs per request).
    assert.equal(await resolveActiveEnv(home, f.sandboxOrgId), null, "revoked: the next resolution refuses");

    // Super admins hold every permission everywhere.
    const platform = { ...home, isSuperAdmin: true };
    assert.equal((await resolveActiveEnv(platform, f.sandboxOrgId))?.actingUserId, f.sandboxUserId);

    // The permission is evaluated in the PRODUCTION org: a role held only inside the sandbox does not count.
    const sandboxRoleId = (await db.execute<{ id: string }>(sql`
      select id from app_roles where org_id = ${f.sandboxOrgId} and key = 'member'`)).rows[0]!.id;
    await setRolePermissions(sandboxRoleId, ["admin.sandboxes.manage"]);
    assert.equal(await resolveActiveEnv(home, f.sandboxOrgId), null, "sandbox-side grant does not admit");

    // Production access is untouched by the sandbox rule.
    assert.equal((await resolveActiveEnv(home, f.homeOrgId))?.actingUserId, f.homeUserId);
  } finally {
    await dropScratchOrg(f.sandboxOrgId);
    await dropScratchOrg(f.homeOrgId);
  }
});
