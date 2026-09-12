import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withOrgTransaction } from "@openbooks/engine/src/db.ts";
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
const { POST, PATCH, DELETE, GET } = (await import(routeUrl)) as typeof import("./route.ts");
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

for (const method of ["POST", "PATCH", "DELETE"] as const) {
  for (const ambient of [false, true]) {
    test(`role ${method} audit failure rolls back role and dashboard writes (${ambient ? "ambient" : "standalone"})`, { skip }, async () => {
      const f = await seed(["admin.roles.manage"]);
      const trigger = `role_audit_${randomUUID().replaceAll("-", "")}`;
      let installed = false;
      try {
        const targetId = await createRole(f.orgId, "atomic_target", []);
        const snapshot = async () => ({
          roles: (await db.execute(sql`select * from app_roles where org_id = ${f.orgId} order by id`)).rows,
          dashboards: (await db.execute(sql`select * from role_dashboard_layouts where org_id = ${f.orgId} order by id`)).rows,
          audit: (await db.execute(sql`select * from audit_log where org_id = ${f.orgId} order by id`)).rows,
        });
        await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
          begin
            if NEW.org_id = '${f.orgId}'::uuid and NEW.table_name = 'app_roles' then
              raise exception 'role audit storage unavailable';
            end if;
            return NEW;
          end $$`));
        await db.execute(sql.raw(`create trigger ${trigger} before insert on audit_log for each row execute function ${trigger}()`));
        installed = true;
        const body = method === "POST"
          ? { name: "Atomic role", key: "atomic_created", permissions: [] }
          : method === "PATCH" ? { id: targetId, name: "Atomic rename" } : { id: targetId };
        const attempt = async () => {
          if (ambient) {
            await db.execute(sql`update app_roles set description = 'earlier caller work' where id = ${targetId}`);
          }
          const before = await snapshot();
          await assert.rejects(call(method, body));
          assert.deepEqual(await snapshot(), before, "failure restores role/default/audit evidence and preserves prior caller work");
        };
        if (ambient) await withOrgTransaction(f.orgId, attempt);
        else await attempt();
        if (ambient) {
          const result = await db.execute(sql`select description from app_roles where id = ${targetId}`);
          assert.equal(result.rows[0]?.description, "earlier caller work");
        }
        await db.execute(sql.raw(`drop trigger ${trigger} on audit_log`));
        installed = false;
        const response = await call(method, body);
        assert.equal(response.status, 200);
        const result = await response.json() as { id?: string };
        const changedId = result.id ?? targetId;
        const evidence = await db.execute(sql`select action from audit_log where org_id = ${f.orgId}
          and table_name = 'app_roles' and row_id = ${changedId}`);
        assert.deepEqual(evidence.rows.map((row) => row.action), [method === "POST" ? "insert" : method === "PATCH" ? "update" : "delete"]);
        if (method === "POST") {
          const layouts = await db.execute(sql`select id from role_dashboard_layouts where org_id = ${f.orgId} and role_key = 'atomic_created'`);
          assert.equal(layouts.rows.length, 1);
        }
      } finally {
        if (installed) await db.execute(sql.raw(`drop trigger ${trigger} on audit_log`));
        await db.execute(sql.raw(`drop function if exists ${trigger}()`));
        routeState.authz = null;
        await dropScratchOrg(f.orgId);
      }
    });
  }
}

for (const method of ["PATCH", "DELETE"] as const) {
  test(`role ${method} checks its permission ceiling after a concurrent role change`, { skip }, async () => {
    const f = await seed(["admin.roles.manage"]);
    const writer = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      const targetUserId = await createScratchUser(f.orgId, "Concurrent target", "concurrent_target");
      const targetId = await roleIdByKey(f.orgId, "concurrent_target");
      const replacementId = await createRole(f.orgId, "concurrent_replacement", []);
      if (method === "PATCH") {
        await db.execute(sql`update app_roles set permissions = '["gl.post"]'::jsonb where id = ${targetId}`);
      }
      await writer.query("begin");
      await writer.query("select set_config('app.bypass_rls', 'on', true)");
      if (method === "PATCH") {
        await writer.query("update app_roles set permissions = '[]'::jsonb where id = $1", [targetId]);
      } else {
        await writer.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`openbooks:role-delete:${f.orgId}`]);
      }
      const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const body = method === "PATCH"
        ? { id: targetId, permissions: ["gl.post"] }
        : { id: targetId, replacementRoleId: replacementId };
      pending = call(method, body);
      let blocked = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        const row = (await pool.query<{ blocked: boolean }>(
          "select exists(select 1 from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))) as blocked", [pid],
        )).rows[0]!;
        if (row.blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(blocked, "request waits for the concurrent transaction");
      if (method === "DELETE") {
        await writer.query(`update app_roles set permissions = '["gl.post"]'::jsonb where id = $1`, [replacementId]);
      }
      await writer.query("commit");
      const response = await pending;
      assert.equal(response.status, 403);
      assert.match((await response.json() as { error: string }).error, /gl.post/);
      assert.deepEqual(await userRoleIds(f.orgId, targetUserId), [targetId]);
      if (method === "PATCH") assert.deepEqual(await rolePermissions(targetId), []);
      const audits = await db.execute(sql`select id from audit_log where org_id = ${f.orgId} and table_name = 'app_roles'
        and row_id = ${targetId}`);
      assert.equal(audits.rows.length, 0, "refused operation adds no audit evidence");
      if (method === "DELETE") {
        await db.execute(sql`update app_roles set permissions = '[]'::jsonb where id = ${replacementId}`);
      } else {
        routeState.authz!.permissions.add("gl.post");
      }
      assert.equal((await call(method, body)).status, 200, "valid current permissions permit the retry");
    } finally {
      await writer.query("rollback");
      writer.release();
      await pending?.catch(() => undefined);
      routeState.authz = null;
      await dropScratchOrg(f.orgId);
    }
  });
}

test("role text fields reject malformed input without changing role state", { skip }, async () => {
  const f = await seed(["admin.roles.manage"]);
  try {
    const snapshot = async () => (await db.execute(sql`select * from app_roles where org_id = ${f.orgId} order by id`)).rows;
    const before = await snapshot();
    for (const method of ["POST", "PATCH"] as const) {
      for (const field of method === "POST" ? ["name", "key", "description"] : ["name", "description"]) {
        for (const value of [42, null, true, [], {}]) {
          const response = await call(method, { id: f.actorRoleId, name: "Validated role", key: "validated_role", [field]: value });
          assert.equal(response.status, 400, `${method} ${field} ${JSON.stringify(value)}`);
          assert.match((await response.json() as { error: string }).error, /must be a string/);
        }
      }
    }
    for (const method of ["PATCH", "DELETE"] as const) {
      assert.equal((await call(method, { id: [f.actorRoleId], name: "Invalid ID" })).status, 400);
    }
    assert.deepEqual(await snapshot(), before);
  } finally { routeState.authz = null; await dropScratchOrg(f.orgId); }
});

for (const mode of ["subtree", "list"] as const) {
  test(`role ${mode} restriction canonicalizes UUID case and preserves tenant boundaries`, { skip }, async () => {
    const f = await seed(["admin.roles.manage"]);
    const other = await createScratchOrg();
    try {
      const subsidiaryId = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id = ${f.orgId} order by id limit 1`)).rows[0]!.id;
      const foreignId = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id = ${other.orgId} order by id limit 1`)).rows[0]!.id;
      const restriction = (id: string) => mode === "subtree"
        ? { mode, subsidiaryId: id.toUpperCase() }
        : { mode, subsidiaryIds: [id.toUpperCase(), id] };
      const create = await call("POST", { name: "Scope role", key: "scope_role", subsidiaryRestriction: restriction(subsidiaryId) });
      assert.equal(create.status, 200);
      const { id } = await create.json() as { id: string };
      const expected = mode === "subtree" ? { mode, subsidiaryId } : { mode, subsidiaryIds: [subsidiaryId] };
      const read = async () => (await db.execute(sql`select subsidiary_restriction from app_roles where id = ${id}`)).rows[0]!.subsidiary_restriction;
      assert.deepEqual(await read(), expected);
      assert.equal((await call("PATCH", { id: id.toUpperCase(), subsidiaryRestriction: restriction(subsidiaryId) })).status, 200);
      assert.equal((await call("PATCH", { id, subsidiaryRestriction: restriction(foreignId) })).status, 400);
      assert.deepEqual(await read(), expected);
      assert.equal((await call("DELETE", { id, replacementRoleId: id.toUpperCase() })).status, 400);
      assert.equal((await call("DELETE", { id: id.toUpperCase() })).status, 200);
    } finally { routeState.authz = null; await dropScratchOrg(f.orgId); await dropScratchOrg(other.orgId); }
  });
}


test("module permission declarations are tenant-scoped, explicitly grantable inside the ceiling, and withdrawn without erasing stored grants", { skip }, async () => {
  const f = await seed(["*"]);
  const other = await createScratchOrg();
  const { requestModuleInstallApproval, decideModuleApproval } = await import("@openbooks/engine/src/modules/lifecycle.ts");
  const { uninstallModule } = await import("@openbooks/engine/src/modules/installer.ts");
  try {
    const requesterId = await createScratchUser(f.orgId, "Module requester", "roles_admin");
    const staged = await requestModuleInstallApproval({ orgId: f.orgId, requesterId,
      manifest: { key: "role-addon", name: "Role addon", version: "1.0.0", permissions: ["admin.roles.manage"], contributions: [{ kind: "permission", key: "role_addon.read", label: "Read role addon" }] },
      installerEffectivePermissions: ["*"], assignees: [{ type: "user", userId: f.actorId }], reason: "Add governed permission" });
    await decideModuleApproval({ gateId: staged.gateIds[0]!, userId: f.actorId, decision: "approved", signature: "Roles admin", approverEffectivePermissions: ["*"] });
    const available = await (await GET()).json();
    assert.ok(available.permissions.some((permission: { key: string }) => permission.key === "role_addon.read"));
    const created = await call("POST", { name: "Addon reader", permissions: ["role_addon.read"] });
    assert.equal(created.status, 200);
    const { id } = await created.json() as { id: string };
    routeState.authz!.permissions = new Set(["admin.roles.manage"]);
    assert.equal((await call("POST", { name: "Beyond ceiling", permissions: ["role_addon.read"] })).status, 403);
    routeState.authz!.user.orgId = other.orgId;
    assert.deepEqual((await (await GET()).json()).permissions, []);
    routeState.authz!.user.orgId = f.orgId;
    routeState.authz!.permissions = new Set(["*"]);
    await uninstallModule({ orgId: f.orgId, actorId: f.actorId, key: "role-addon", reason: "Withdraw addon" });
    assert.deepEqual((await (await GET()).json()).permissions, []);
    assert.deepEqual(await rolePermissions(id), ["role_addon.read"]);
    assert.equal((await call("POST", { name: "Inactive permission", permissions: ["role_addon.read"] })).status, 400);
    assert.equal((await call("PATCH", { id, permissions: ["role_addon.read", "gl.read"] })).status, 200);
    assert.equal((await call("PATCH", { id, permissions: ["gl.read"] })).status, 200);
  } finally { routeState.authz = null; await dropScratchOrg(f.orgId); await dropScratchOrg(other.orgId); }
});
