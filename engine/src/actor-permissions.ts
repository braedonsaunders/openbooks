import { sql } from "drizzle-orm";
import { db, withBypassContext, type SqlExecutor } from "./db.ts";
import { permissionSetCovers, resolveEffectivePermissions } from "./permissions.ts";

/** Read a home identity without losing changes in the caller's tenant transaction. */
export async function actorIdentity(exec: SqlExecutor, orgId: string, actorId: string) {
  // Preserve the caller's uncommitted identity changes when it belongs to
  // this tenant. Only a home-org identity outside that view needs the explicit
  // identity bypass used by HTTP authentication.
  type Identity = { isSuperAdmin: boolean; isActive: boolean };
  const local = (await exec.execute<Identity>(sql`
    select is_super_admin as "isSuperAdmin", is_active as "isActive"
      from users where id = ${actorId} and org_id = ${orgId}
  `)).rows[0];
  return local ?? (await withBypassContext(() => db.execute<Identity>(sql`
    select is_super_admin as "isSuperAdmin", is_active as "isActive"
      from users where id = ${actorId}
  `))).rows[0];
}

/**
 * Effective permission check for ENGINE-side authority gates — the deep
 * boundary where no HTTP session exists to run web/lib/authz.ts
 * (posting flows, sandboxed scripts, subledger services).
 *
 * A principal may act only when their live tenant authorization covers the
 * required key: every active user's assigned app_role permission sets are
 * unioned, grant overrides are added, deny overrides win, and wildcard keys
 * match exactly like `web/lib`'s can(). Platform super admins hold every
 * permission in whatever org they are currently in (the documented authz.ts
 * contract); unknown or inactive principals fail closed.
 *
 * Takes an executor so callers already inside an org transaction reuse its
 * connection view (`tx`), and standalone callers pass `db`.
 */
export async function actorHasPermission(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  permission: string,
): Promise<boolean> {
  const row = await actorIdentity(exec, orgId, actorId);
  if (!row?.isActive) return false;
  if (row.isSuperAdmin) return true;

  const assignments = (await exec.execute<{ permissions: string[] | null }>(sql`
    select role.permissions
      from role_assignments assignment
      join app_roles role
        on role.id = assignment.role_id and role.org_id = assignment.org_id
     where assignment.user_id = ${actorId} and assignment.org_id = ${orgId}
  `));
  const overrides = (await exec.execute<{
    permission: string;
    effect: "grant" | "deny";
  }>(sql`
    select permission, effect
      from user_permission_overrides
     where user_id = ${actorId} and org_id = ${orgId}
  `));
  return permissionSetCovers(
    resolveEffectivePermissions({
      rolePermissionSets: assignments.rows.map((r) =>
        Array.isArray(r.permissions) ? r.permissions : [],
      ),
      overrides: overrides.rows,
    }),
    permission,
  );
}
