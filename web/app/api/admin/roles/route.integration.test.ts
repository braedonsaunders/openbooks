import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { PERMISSION_CATALOGUE } from "@openbooks/engine/src/permissions.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/src/test-fixtures.ts";

// Boundary suite for /api/admin/roles against the real schema.
//
//   ID2 — admin.roles.manage is an ordinary permission. An administrator may
//         only create a role, or ADD permissions to a role, from inside their
//         own effective permission set; otherwise the route is a one-call
//         escalation to the full catalogue.
//   ID3 — deleting a role must not strand an active user with zero roles
//         (currentUser() bounces such a user to /login on their next request).
//         The route refuses (409) unless a replacement role is supplied, and
//         every removed/replaced assignment leaves its own audit row inside
//         the same transaction as the role deletion.
const stateKey = Symbol.for("openbooks.admin-roles-route-integration-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string; isSuperAdmin: boolean };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.admin-roles-route-integration-test')]
  export async function guardPermission(perm) {
    if (!state.authz) return Response.json({ error: 'unauthorized' }, { status: 401 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    if (specifier === "../../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") return { format: "module", source: mockAuthz, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const routeUrl = "./route.ts?admin-roles-integration";
const { POST, PATCH, DELETE } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const skip = !process.env.OPENBOOKS_DB_URL;

function call(method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>): Promise<Response> {
  const handler = method === "POST" ? POST : method === "PATCH" ? PATCH : DELETE;
  return handler(
    new Request("http://openbooks.test/api/admin/roles", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function rolePermissions(roleId: string): Promise<string[]> {
  const r = await db.execute<{ permissions: string[] }>(sql`select permissions from app_roles where id = ${roleId}`);
  return r.rows[0]?.permissions ?? [];
}

async function roleIdByKey(orgId: string, key: string): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`select id from app_roles where org_id = ${orgId} and key = ${key}`);
  assert.ok(r.rows[0], `role ${key} exists`);
  return r.rows[0]!.id;
}

async function createRole(orgId: string, key: string, permissions: string[]): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`
    insert into app_roles (org_id, key, name, is_built_in, permissions)
    values (${orgId}, ${key}, ${key}, false, ${JSON.stringify(permissions)}::jsonb)
    returning id`);
  return r.rows[0]!.id;
}

async function userRoleIds(orgId: string, userId: string): Promise<string[]> {
  const r = await db.execute<{ role_id: string }>(sql`
    select role_id from role_assignments where org_id = ${orgId} and user_id = ${userId} order by role_id`);
  return r.rows.map((row) => row.role_id);
}

interface Fixture {
  orgId: string;
  actorId: string;
  actorRoleId: string;
}

async function seed(actorPermissions: string[]): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Roles admin", "roles_admin");
  const actorRoleId = await roleIdByKey(org.orgId, "roles_admin");
  await db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(actorPermissions)}::jsonb where id = ${actorRoleId}`);
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId, isSuperAdmin: false },
    permissions: new Set(actorPermissions),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId, actorRoleId };
}

test("ID2: an administrator holding only admin.roles.manage cannot widen their own role to the catalogue", { skip }, async () => {
  const f = await seed(["admin.roles.manage"]);
  try {
    const response = await call("PATCH", { id: f.actorRoleId, permissions: [...PERMISSION_CATALOGUE] });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string; missing?: string[] };
    assert.match(body.error, /gl\.post/);
    assert.ok(Array.isArray(body.missing) && body.missing.includes("admin.users.manage"));
    assert.deepEqual(await rolePermissions(f.actorRoleId), ["admin.roles.manage"], "the role is untouched");
  } finally {
    routeState.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("ID2: a role may only be created, or grow, inside the actor's own permissions", { skip }, async () => {
  const f = await seed(["admin.roles.manage", "gl.read", "ap.*"]);
  try {
    const refused = await call("POST", { name: "Escalated", permissions: ["gl.read", "gl.post"] });
    assert.equal(refused.status, 403);
    assert.deepEqual(((await refused.json()) as { missing: string[] }).missing, ["gl.post"]);
    const missing = await db.execute(sql`select 1 from app_roles where org_id = ${f.orgId} and key = 'escalated'`);
    assert.equal(missing.rows.length, 0, "the escalated role was not created");

    const created = await call("POST", { name: "Within", permissions: ["gl.read", "ap.read", "ap.approve"] });
    assert.equal(created.status, 200, "module wildcards cover their keys");
    const { id } = (await created.json()) as { id: string };

    // Removing permissions the actor lacks is not an escalation and stays allowed.
    const wide = await createRole(f.orgId, "wide", ["gl.read", "gl.post", "admin.users.manage"]);
    const narrowed = await call("PATCH", { id: wide, permissions: ["gl.read", "gl.post"] });
    assert.equal(narrowed.status, 200);
    assert.deepEqual(await rolePermissions(wide), ["gl.read", "gl.post"]);
    // Keeping an existing out-of-ceiling permission while adding one the actor holds is fine…
    const kept = await call("PATCH", { id: wide, permissions: ["gl.read", "gl.post", "ap.read"] });
    assert.equal(kept.status, 200);
    // …but adding one the actor lacks is refused.
    const grown = await call("PATCH", { id, permissions: ["gl.read", "admin.users.manage"] });
    assert.equal(grown.status, 403);
    assert.deepEqual(await rolePermissions(id), ["gl.read", "ap.read", "ap.approve"]);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("ID3: deleting a role refuses to strand an active user, reassigns on request, and audits every assignment", { skip }, async () => {
  const f = await seed(["admin.roles.manage", "gl.read", "ap.read"]);
  try {
    // U holds only `doomed`; V holds `doomed` plus another role; W is inactive with only `doomed`.
    const userId = await createScratchUser(f.orgId, "Only holder", "doomed");
    const doomed = await roleIdByKey(f.orgId, "doomed");
    const otherId = await createScratchUser(f.orgId, "Two roles", "other_role");
    await db.execute(sql`insert into role_assignments (org_id, user_id, role_id) values (${f.orgId}, ${otherId}, ${doomed})`);
    const inactiveId = await createScratchUser(f.orgId, "Departed", "doomed");
    await db.execute(sql`update users set is_active = false where id = ${inactiveId}`);
    const replacement = await createRole(f.orgId, "replacement", ["gl.read"]);
    const tooWide = await createRole(f.orgId, "too_wide", ["gl.read", "gl.post"]);

    const refused = await call("DELETE", { id: doomed });
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { error: string; affectedUsers?: { id: string }[]; affectedCount?: number };
    assert.equal(body.affectedCount, 1, "only the active user whose sole role this is blocks deletion");
    assert.deepEqual(body.affectedUsers?.map((u) => u.id), [userId]);
    assert.match(body.error, /Only holder/);
    assert.equal((await db.execute(sql`select 1 from app_roles where id = ${doomed}`)).rows.length, 1, "role kept");
    assert.deepEqual(await userRoleIds(f.orgId, userId), [doomed], "assignment kept");

    const beyondCeiling = await call("DELETE", { id: doomed, replacementRoleId: tooWide });
    assert.equal(beyondCeiling.status, 403, "the replacement is subject to the ID2 ceiling");
    assert.equal((await db.execute(sql`select 1 from app_roles where id = ${doomed}`)).rows.length, 1);

    const self = await call("DELETE", { id: doomed, replacementRoleId: doomed });
    assert.equal(self.status, 400, "a role cannot replace itself");

    const ok = await call("DELETE", { id: doomed, replacementRoleId: replacement });
    assert.equal(ok.status, 200, await ok.text());
    assert.equal((await db.execute(sql`select 1 from app_roles where id = ${doomed}`)).rows.length, 0, "role deleted");
    assert.deepEqual(await userRoleIds(f.orgId, userId), [replacement], "the stranded user now holds the replacement");
    assert.deepEqual(await userRoleIds(f.orgId, otherId), [await roleIdByKey(f.orgId, "other_role")], "a user with another role is not widened");
    assert.deepEqual(await userRoleIds(f.orgId, inactiveId), [], "inactive users just lose the assignment");

    const audits = await db.execute<{ table_name: string; action: string; changes: Record<string, unknown> }>(sql`
      select table_name, action, changes from audit_log
       where org_id = ${f.orgId} and actor_id = ${f.actorId}
       order by at, id`);
    const assignmentDeletes = audits.rows.filter((r) => r.table_name === "role_assignments" && r.action === "delete");
    const assignmentInserts = audits.rows.filter((r) => r.table_name === "role_assignments" && r.action === "insert");
    assert.equal(assignmentDeletes.length, 3, "one delete audit row per removed assignment");
    assert.deepEqual(
      assignmentDeletes.map((r) => (r.changes.userId as [string, null])[0]).sort(),
      [userId, otherId, inactiveId].sort(),
    );
    assert.ok(assignmentDeletes.every((r) => (r.changes.roleId as [string, null])[0] === doomed));
    assert.equal(assignmentInserts.length, 1, "the replacement grant is audited");
    assert.deepEqual(assignmentInserts[0]!.changes.userId, [null, userId]);
    assert.deepEqual(assignmentInserts[0]!.changes.roleId, [null, replacement]);
    assert.equal(audits.rows.filter((r) => r.table_name === "app_roles" && r.action === "delete").length, 1);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(f.orgId);
  }
});

test("ID3: a role nobody depends on still deletes cleanly and audits each removed assignment", { skip }, async () => {
  const f = await seed(["admin.roles.manage"]);
  try {
    const holder = await createScratchUser(f.orgId, "Holder", "keeper");
    const extra = await createRole(f.orgId, "extra", []);
    await db.execute(sql`insert into role_assignments (org_id, user_id, role_id) values (${f.orgId}, ${holder}, ${extra})`);
    const response = await call("DELETE", { id: extra });
    assert.equal(response.status, 200);
    assert.deepEqual(await userRoleIds(f.orgId, holder), [await roleIdByKey(f.orgId, "keeper")]);
    const audits = await db.execute<{ changes: Record<string, unknown> }>(sql`
      select changes from audit_log
       where org_id = ${f.orgId} and table_name = 'role_assignments' and action = 'delete'`);
    assert.equal(audits.rows.length, 1);
    assert.deepEqual(audits.rows[0]!.changes.userId, [holder, null]);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(f.orgId);
  }
});
